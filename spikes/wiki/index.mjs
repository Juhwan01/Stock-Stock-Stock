/**
 * 위키 인덱서: 마크다운 정본 → SQLite 파생 인덱스
 *
 * 설계 원칙
 *  - 마크다운이 진실의 원천. SQLite는 언제든 버리고 재구축 가능한 캐시.
 *  - 엣지는 바이템포럴: valid_from / valid_until / recorded_at / confidence.
 *    사실이 틀린 것으로 밝혀져도 지우지 않고 valid_until을 찍는다 (역사 보존).
 *  - 네이티브 의존성 없음 — Node 24 내장 node:sqlite 사용 (Electron 패키징 단순화)
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const WIKILINK = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

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

export function buildIndex(wikiDir, dbPath = ':memory:') {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE nodes (
      id        TEXT PRIMARY KEY,
      type      TEXT NOT NULL,
      title     TEXT NOT NULL,
      ticker    TEXT,
      date      TEXT,           -- Event/Decision의 발생일
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
    `INSERT INTO nodes (id, type, title, ticker, date, tags, path, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insEdge = db.prepare(
    `INSERT INTO edges (src, rel, dst, direction, confidence, valid_from, valid_until, recorded_at, note, source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insFts = db.prepare(`INSERT INTO fts (id, title, body) VALUES (?, ?, ?)`);

  const now = new Date().toISOString().slice(0, 10);
  const files = readdirSync(wikiDir).filter((f) => f.endsWith('.md'));
  let edgeCount = 0;

  for (const f of files) {
    const { id, fm, body, links, path } = parsePage(join(wikiDir, f));

    insNode.run(
      id,
      fm.type ?? 'Note',
      fm.title ?? id,
      fm.ticker ?? null,
      fm.date ?? null,
      JSON.stringify(fm.tags ?? []),
      path,
      fm.decision ? JSON.stringify(fm.decision) : null,
    );
    insFts.run(id, fm.title ?? id, body);

    // 프론트매터의 타입 있는 엣지
    for (const e of fm.edges ?? []) {
      insEdge.run(
        id,
        e.rel,
        e.to,
        e.direction ?? null,
        e.confidence ?? null,
        e.valid_from ?? fm.date ?? null,
        e.valid_until ?? null,
        now,
        e.note ?? null,
        (fm.sources ?? [])[0] ?? null,
      );
      edgeCount++;
    }

    // 본문 [[위키링크]] — 타입 없는 약한 연결 (백링크용)
    for (const target of new Set(links)) {
      insEdge.run(id, 'mentions', target, null, null, fm.date ?? null, null, now, null, null);
      edgeCount++;
    }
  }

  // 무결성: 존재하지 않는 노드를 가리키는 엣지 (오타·미작성 페이지 탐지)
  const dangling = db
    .prepare(`SELECT DISTINCT dst FROM edges WHERE dst NOT IN (SELECT id FROM nodes)`)
    .all()
    .map((r) => r.dst);

  return { db, stats: { nodes: files.length, edges: edgeCount, dangling } };
}

/** 한국어 대응 검색 라우터: 3글자 이상은 FTS MATCH, 2글자 이하는 LIKE 폴백 */
export function search(db, q, limit = 5) {
  const useFts = [...q].filter((c) => !/\s/.test(c)).length >= 3;
  const sql = useFts
    ? `SELECT f.id, n.type, n.title, bm25(fts) AS score FROM fts f
       JOIN nodes n ON n.id = f.id WHERE fts MATCH ? ORDER BY score LIMIT ?`
    : `SELECT f.id, n.type, n.title, 0 AS score FROM fts f
       JOIN nodes n ON n.id = f.id WHERE f.title LIKE '%' || ? || '%' OR f.body LIKE '%' || ? || '%' LIMIT ?`;
  const rows = useFts ? db.prepare(sql).all(q, limit) : db.prepare(sql).all(q, q, limit);
  return { mode: useFts ? 'FTS5 trigram MATCH' : 'LIKE 폴백 (2글자 이하)', rows };
}

/** k-hop 그래프 탐색. asOf를 주면 그 시점에 유효했던 엣지만 따라간다 (바이템포럴). */
export function traverse(db, startId, { hops = 2, asOf = null, rels = null } = {}) {
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
  const cur = db.prepare(`SELECT * FROM nodes WHERE id = ?`).get(currentId);
  if (!cur) return [];
  const tags = JSON.parse(cur.tags);
  if (!tags.length) return [];

  // node:sqlite 는 위치 파라미터와 명명 파라미터의 혼용을 허용하지 않는다 — 전부 위치로 통일.
  const rows = db
    .prepare(
      `SELECT d.id, d.title, d.date, d.payload,
              (SELECT count(*) FROM json_each(d.tags) t
                WHERE t.value IN (${tags.map(() => '?').join(',')})) AS tag_overlap,
              EXISTS(SELECT 1 FROM edges e
                      WHERE e.rel = 'similar-to' AND e.src = ?
                        AND (e.dst = d.id OR e.dst IN (SELECT dst FROM edges WHERE src = d.id))) AS linked
       FROM nodes d
       WHERE d.type = 'Decision' AND d.id != ?
       ORDER BY linked DESC, tag_overlap DESC`,
    )
    .all(...tags, currentId, currentId);

  return rows
    .filter((r) => r.tag_overlap > 0 || r.linked)
    .map((r) => ({ ...r, decision: JSON.parse(r.payload ?? '{}') }));
}
