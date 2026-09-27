/**
 * 위키 인덱서: 마크다운 정본 → SQLite 파생 인덱스 (spikes/wiki/index.mjs 에서 이식)
 *
 * 설계 원칙
 *  - 마크다운이 진실의 원천. SQLite는 언제든 버리고 재구축 가능한 캐시.
 *  - 엣지는 바이템포럴: valid_from / valid_until / recorded_at / confidence.
 *    사실이 틀린 것으로 밝혀져도 지우지 않고 valid_until을 찍는다 (역사 보존).
 *  - 네이티브 의존성 없음 — Node 24 내장 node:sqlite 사용
 *
 * 스파이크와 달라진 점
 *  - 페이지는 wiki/pages/ 에만 둔다. wiki/ 루트에는 AGENTS.md·briefings/ 가 함께 있다.
 *  - 깨진 페이지·엣지 하나가 서버 전체를 죽이지 않는다 — 페이지 단위 SAVEPOINT 로 격리하고 보고한다.
 *    (실측: AGENTS.md 를 페이지로 읽다가 MCP 서버가 기동 중 죽었다. LLM 이 쓰기 쉬운 `to: [[x]]`,
 *    객체형 sources 도 SQLite 바인딩에서 인덱스 전체를 죽였다 — 코드 리뷰 재현)
 *  - 에이전트가 파일을 직접 고쳐도 반영되도록, 조회 때마다 디렉터리 서명을 보고 필요할 때만 재구축한다.
 *    새 인덱스를 다 만든 뒤에 옛 것을 닫는다 — 재구축이 실패해도 서버는 계속 답한다.
 *  - 심볼릭 링크 페이지는 읽지 않는다. 쓰기 전에는 pages/ 가 위키 안의 실제 디렉터리인지 확인한다 —
 *    서버는 샌드박스 밖에서 돌므로 에이전트가 링크로 쓰기 위치를 바꾸는 우회를 막아야 한다.
 */
import { DatabaseSync } from 'node:sqlite';
import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

export const NODE_TYPES = ['Company', 'Person', 'Sector', 'Theme', 'MacroIndicator', 'Event', 'Decision', 'Source', 'Note'];
export const EDGE_RELS = [
  'causes', 'affects', 'supplies-to', 'customer-of', 'competes-with', 'belongs-to', 'precedes',
  'similar-to', 'triggered-by', 'resulted-in', 'invalidated-by', 'derived-from', 'about',
];

export function parsePage(path) {
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(FRONTMATTER);
  if (!m) throw new Error(`프론트매터 없음: ${path}`);
  const fm = parseYaml(m[1]) ?? {};
  const body = m[2];
  const id = fm.id ?? basename(path, '.md');
  const links = [...body.matchAll(WIKILINK)].map((x) => x[1].trim());
  return { id, fm, body, links, path };
}

/** 타입별 필수 필드 — AGENTS.md §3 과 같은 규칙. 인덱싱은 막지 않고 보고만 한다 */
const REQUIRED = {
  Company: (fm) => (typeof fm.ticker === 'string' && fm.ticker ? null : 'ticker(문자열) 필수 — 한국 6자리는 따옴표로 감싼다'),
  Event: (fm) => (!fm.date ? 'date 필수' : !Array.isArray(fm.sources) || !fm.sources.length ? 'sources 필수' : null),
  Decision: (fm) => {
    const d = fm.decision ?? {};
    const missing = ['thesis', 'confidence', 'invalidation_condition'].filter((k) => d[k] == null || d[k] === '');
    return !fm.date ? 'date 필수' : missing.length ? `decision.${missing.join(', decision.')} 필수` : null;
  },
};

// SQLite 에 바인딩할 수 있는 값으로 — 객체·배열이 오면 인덱스 전체가 죽는다
const scalar = (v) => (v == null ? null : typeof v === 'string' || typeof v === 'number' ? v : typeof v === 'boolean' ? String(v) : JSON.stringify(v));
const sourceRef = (s) => (s == null ? null : typeof s === 'string' ? s : typeof s === 'object' && typeof s.url === 'string' ? s.url : JSON.stringify(s));
const asTags = (t) => (Array.isArray(t) ? t.filter((x) => x != null).map(String) : t == null ? [] : [String(t)]);

const pageFiles = (pagesDir) => {
  try {
    return readdirSync(pagesDir).filter((f) => f.endsWith('.md')).sort();
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
};

export function buildIndex(pagesDir, dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE nodes (
      id        TEXT PRIMARY KEY,
      type      TEXT NOT NULL,
      title     TEXT NOT NULL,
      ticker    TEXT,
      date      TEXT,           -- Event/Decision의 발생일
      status    TEXT,           -- Decision: open / closed
      tags      TEXT,           -- JSON 배열
      path      TEXT NOT NULL,
      payload   TEXT            -- Decision 등 타입별 구조화 필드 (JSON)
    );

    CREATE TABLE edges (
      src         TEXT NOT NULL,
      rel         TEXT NOT NULL,
      dst         TEXT NOT NULL,
      direction   TEXT,                    -- affects 의 +/-
      confidence  REAL,
      valid_from  TEXT,
      valid_until TEXT,                    -- NULL = 현재도 유효
      recorded_at TEXT NOT NULL,
      note        TEXT,
      source_ref  TEXT
    );
    CREATE INDEX idx_edges_src ON edges(src);
    CREATE INDEX idx_edges_dst ON edges(dst);
    CREATE INDEX idx_edges_rel ON edges(rel);

    -- 한국어 대응: unicode61은 'SK하이닉스' 안의 '하이닉스'를 못 찾는다. trigram 필수.
    CREATE VIRTUAL TABLE fts USING fts5(id UNINDEXED, title, body, tokenize='trigram');
  `);

  const insNode = db.prepare(
    `INSERT INTO nodes (id, type, title, ticker, date, status, tags, path, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insEdge = db.prepare(
    `INSERT INTO edges (src, rel, dst, direction, confidence, valid_from, valid_until, recorded_at, note, source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insFts = db.prepare(`INSERT INTO fts (id, title, body) VALUES (?, ?, ?)`);

  const now = new Date().toISOString().slice(0, 10);
  const invalid = [];
  const badEdges = [];
  const schemaIssues = [];
  let nodeCount = 0;
  let edgeCount = 0;

  for (const f of pageFiles(pagesDir)) {
    const st = lstatSync(join(pagesDir, f));
    if (st.isSymbolicLink()) {
      invalid.push({ file: f, error: '심볼릭 링크는 읽지 않는다' });
      continue;
    }
    if (!st.isFile()) continue;

    db.exec('SAVEPOINT page');
    let edgesHere = 0;
    try {
      const { id, fm, body, links, path } = parsePage(join(pagesDir, f));
      const tags = asTags(fm.tags);
      insNode.run(
        String(id),
        scalar(fm.type) ?? 'Note',
        scalar(fm.title) ?? String(id),
        fm.ticker == null ? null : String(fm.ticker),
        scalar(fm.date),
        scalar(fm.status),
        JSON.stringify(tags),
        path,
        fm.decision && typeof fm.decision === 'object' ? JSON.stringify(fm.decision) : null,
      );
      insFts.run(String(id), scalar(fm.title) ?? String(id), body);

      const type = fm.type ?? 'Note';
      if (!NODE_TYPES.includes(type)) schemaIssues.push({ id, issue: `알 수 없는 type: ${type}` });
      const req = REQUIRED[type]?.(fm);
      if (req) schemaIssues.push({ id, issue: req });

      // 프론트매터의 타입 있는 엣지 — 모양이 틀린 엣지는 건너뛰고 보고한다
      const edges = fm.edges == null ? [] : Array.isArray(fm.edges) ? fm.edges : null;
      if (!edges) badEdges.push({ from: id, reason: 'edges 는 목록이어야 한다' });
      for (const [i, e] of (edges ?? []).entries()) {
        if (!e || typeof e !== 'object' || typeof e.rel !== 'string' || typeof e.to !== 'string') {
          badEdges.push({ from: id, index: i, reason: 'rel·to 는 문자열이어야 한다 (to: [[x]] 가 아니라 to: x)' });
          continue;
        }
        insEdge.run(
          id, e.rel, e.to, scalar(e.direction),
          typeof e.confidence === 'number' ? e.confidence : null,
          scalar(e.valid_from) ?? scalar(fm.date), scalar(e.valid_until), now, scalar(e.note),
          sourceRef(Array.isArray(fm.sources) ? fm.sources[0] : fm.sources),
        );
        edgesHere++;
      }

      // 본문 [[위키링크]] — 타입 없는 약한 연결 (백링크용)
      for (const target of new Set(links)) {
        insEdge.run(id, 'mentions', target, null, null, scalar(fm.date), null, now, null, null);
        edgesHere++;
      }
      db.exec('RELEASE page');
      nodeCount++;
      edgeCount += edgesHere;
    } catch (e) {
      db.exec('ROLLBACK TO page');
      db.exec('RELEASE page');
      invalid.push({ file: f, error: e.message });
    }
  }

  // 무결성: 존재하지 않는 노드를 가리키는 엣지 (오타·미작성 페이지 탐지)
  const dangling = db
    .prepare(`SELECT DISTINCT src, rel, dst FROM edges WHERE dst NOT IN (SELECT id FROM nodes)`)
    .all()
    .map((r) => ({ from: r.src, rel: r.rel, to: r.dst }));
  const unknownRels = db
    .prepare(`SELECT DISTINCT src, rel FROM edges WHERE rel != 'mentions' AND rel NOT IN (${EDGE_RELS.map(() => '?').join(',')})`)
    .all(...EDGE_RELS)
    .map((r) => ({ from: r.src, rel: r.rel }));

  return { db, stats: { nodes: nodeCount, edges: edgeCount, dangling, invalid, badEdges, schemaIssues, unknownRels } };
}

/** 디렉터리 서명 — 파일 추가·삭제·수정 중 하나라도 있으면 바뀐다 */
function signature(pagesDir) {
  return pageFiles(pagesDir)
    .map((f) => {
      try {
        const s = lstatSync(join(pagesDir, f));
        return `${f}:${s.mtimeMs}:${s.size}:${s.isSymbolicLink() ? 'l' : ''}`;
      } catch {
        return `${f}:gone`;
      }
    })
    .join('|');
}

/** 조회할 때마다 서명을 확인하고, 바뀌었을 때만 재구축하는 인덱스. root 는 쓰기 경계 확인용 위키 루트 */
export function createWiki(pagesDir, { root = null } = {}) {
  let sig = null;
  let current = null;
  return {
    pagesDir,
    get() {
      const s = signature(pagesDir);
      if (s !== sig || !current) {
        const next = buildIndex(pagesDir); // 다 만든 뒤에 바꿔 끼운다
        current?.db.close();
        current = next;
        sig = s;
      }
      return current;
    },
    has(id) {
      return !!this.get().db.prepare(`SELECT 1 FROM nodes WHERE id = ?`).get(id);
    },
    /** 쓰기 직전 확인: pages/ 가 링크가 아닌 실제 디렉터리이고 위키 루트 안에 있다 */
    assertWritable() {
      let st;
      try {
        st = lstatSync(pagesDir);
      } catch {
        throw new Error(`pages/ 가 없음: ${pagesDir} — sss init`);
      }
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`pages/ 가 실제 디렉터리가 아님 (링크 금지): ${pagesDir}`);
      if (root && realpathSync(pagesDir) !== join(realpathSync(root), 'pages')) {
        throw new Error(`pages/ 가 위키 밖을 가리킴: ${realpathSync(pagesDir)}`);
      }
    },
  };
}

/** 한국어 대응 검색 라우터: 3글자 이상은 FTS MATCH, 2글자 이하는 LIKE 폴백 */
export function search(db, q, limit = 5) {
  const useFts = [...q].filter((c) => !/\s/.test(c)).length >= 3;
  // FTS5 쿼리 문법(따옴표·연산자)이 섞인 입력이 구문 오류를 내지 않도록 구(phrase)로 감싼다
  const phrase = `"${q.replace(/"/g, '""')}"`;
  const like = q.replace(/[\\%_]/g, '\\$&'); // LIKE 의 % _ 를 글자 그대로
  const sql = useFts
    ? `SELECT f.id, n.type, n.title, bm25(fts) AS score FROM fts f
       JOIN nodes n ON n.id = f.id WHERE fts MATCH ? ORDER BY score LIMIT ?`
    : `SELECT f.id, n.type, n.title, 0 AS score FROM fts f
       JOIN nodes n ON n.id = f.id
       WHERE f.title LIKE '%' || ? || '%' ESCAPE '\\' OR f.body LIKE '%' || ? || '%' ESCAPE '\\' LIMIT ?`;
  const rows = useFts ? db.prepare(sql).all(phrase, limit) : db.prepare(sql).all(like, like, limit);
  return { mode: useFts ? 'FTS5 trigram MATCH' : 'LIKE 폴백 (2글자 이하)', rows };
}

/** k-hop 그래프 탐색. asOf를 주면 그 시점에 유효했던 엣지만 따라간다 (바이템포럴). */
const assertNode = (db, id) => {
  if (!db.prepare(`SELECT 1 FROM nodes WHERE id = ?`).get(id)) throw new Error(`위키에 없는 노드: ${id} — wiki_search 로 id 를 먼저 찾는다`);
};

export function traverse(db, startId, { hops = 2, asOf = null, rels = null } = {}) {
  assertNode(db, startId);
  const relFilter = rels ? `AND e.rel IN (${rels.map(() => '?').join(',')})` : '';
  const timeFilter = asOf
    ? `AND (e.valid_from IS NULL OR e.valid_from <= ?)
       AND (e.valid_until IS NULL OR e.valid_until > ?)`
    : '';
  const sql = `
    WITH RECURSIVE walk(id, depth, path) AS (
      SELECT ?, 0, ?
      UNION
      SELECT CASE WHEN e.src = w.id THEN e.dst ELSE e.src END, w.depth + 1,
             w.path || ' → ' || CASE WHEN e.src = w.id THEN e.dst ELSE e.src END
      FROM walk w
      JOIN edges e ON (e.src = w.id OR e.dst = w.id) ${relFilter} ${timeFilter}
      WHERE w.depth < ?
    )
    SELECT min(w.depth) AS depth, w.id, n.type, n.title, n.date, w.path
    FROM walk w JOIN nodes n ON n.id = w.id
    WHERE w.depth > 0 AND w.id != ?   -- 시작 노드가 되돌아오는 경로 제외
    GROUP BY w.id
    ORDER BY depth, n.date`;
  // node:sqlite 는 위치/명명 파라미터 혼용 불가 — SQL 등장 순서대로 위치 바인딩한다.
  const params = [startId, startId, ...(rels ?? []), ...(asOf ? [asOf, asOf] : []), hops, startId];
  return db.prepare(sql).all(...params);
}

/**
 * 유사 과거 상황 소환 — 제품의 핵심 기능.
 * 현재 상황 노드의 태그·명시적 similar-to 링크를 타고 과거 Decision과 그 결과를 끌어온다.
 */
export function findSimilarCases(db, currentId) {
  assertNode(db, currentId);
  const cur = db.prepare(`SELECT tags FROM nodes WHERE id = ?`).get(currentId);

  // 태그는 JSON 파라미터로 넘긴다 — 태그가 없어도 similar-to 링크만으로 소환된다
  const rows = db
    .prepare(
      `SELECT d.id, d.title, d.date, d.payload,
              (SELECT count(*) FROM json_each(d.tags) t
                WHERE t.value IN (SELECT value FROM json_each(?))) AS tag_overlap,
              EXISTS(SELECT 1 FROM edges e
                      WHERE e.rel = 'similar-to' AND e.src = ?
                        AND (e.dst = d.id OR e.dst IN (SELECT dst FROM edges WHERE src = d.id))) AS linked
       FROM nodes d
       WHERE d.type = 'Decision' AND d.id != ?
       ORDER BY linked DESC, tag_overlap DESC`,
    )
    .all(cur.tags, currentId, currentId);

  return rows
    .filter((r) => r.tag_overlap > 0 || r.linked)
    .map(({ payload, ...r }) => ({ ...r, decision: JSON.parse(payload ?? '{}') }));
}
