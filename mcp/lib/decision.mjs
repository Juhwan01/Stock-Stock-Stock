/**
 * Decision 레코드 — 의사결정 저널의 쓰기 경로 (PLAN.md §3 "Decision 레코드")
 *
 * 위키의 다른 페이지는 에이전트가 파일 편집으로 직접 쓰지만, Decision 은 이 도구로만 만든다.
 *  - 스키마 강제: 무효화 조건·확신도 없는 판단은 나중에 되먹임이 불가능하다
 *  - user_confirmed: 모델이 채우는 값이라 강제가 아니라 "확인했는가"를 한 번 더 따지게 하는 장치다.
 *    실제 강제는 bin/sss 가 이 도구들을 대화형에서 사용자 승인(prompt)으로 거는 것이다
 *  - 참조 무결성: about/triggered-by 가 가리키는 노드가 위키에 없으면 거부 — 엔티티를 먼저 만들게 한다
 *  - 결과 업데이트는 프론트매터의 주석과 본문을 보존한 채 필드만 덧붙인다 (yaml Document API)
 *  - 쓰기 경계: 서버는 샌드박스 밖에서 돈다. pages/ 가 실제 디렉터리인지 확인하고, 갱신은 임시 파일 +
 *    rename 으로 한다 — rename 은 링크를 따라가지 않고 링크 자체를 바꾼다 (코드 리뷰에서 위키 밖 쓰기 재현)
 */
import { z } from 'zod';
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, stringify } from 'yaml';

export const ACTIONS = ['매수', '매도', '관망', '비중확대', '비중축소'];
const nodeId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, '위키 노드 id (소문자·숫자·하이픈)');
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const confirmed = z.literal(true, { message: '사용자가 대화에서 명시적으로 확인한 뒤에만 true 로 호출한다' });

export const recordShape = {
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,40}$/).describe('영문 소문자 kebab 요약, 예: hynix-reduce. id 는 decision-<slug>-<date>'),
  date: day.optional().describe('판단일. 생략하면 오늘'),
  title: z.string().min(4).describe('한 줄 제목, 예: SK하이닉스 비중 축소 (루빈 지연 대응)'),
  about: z.array(nodeId).min(1).describe('판단 대상 엔티티 노드 id — 위키에 이미 있어야 한다'),
  triggered_by: z.array(nodeId).default([]).describe('판단을 촉발한 Event/Source 노드 id'),
  action: z.enum(ACTIONS),
  thesis: z.string().min(10).describe('판단의 논지'),
  confidence: z.number().int().min(1).max(10),
  expected_outcome: z.string().min(4).describe('기대 시나리오'),
  expected_probability: z.number().min(0).max(1).optional(),
  invalidation_condition: z.string().min(10).describe('틀렸다고 인정할 조건 — 데이터/이벤트/날짜로 판정 가능한 형태'),
  time_horizon: z.string().min(2).describe('유효 기간, 예: 3개월, 다음 실적 발표까지'),
  emotion: z.string().optional().describe('당시 감정'),
  tags: z.array(z.string()).default([]).describe('유사 케이스 소환에 쓰이는 태그 — 관련 Event 의 태그와 맞춘다'),
  note: z.string().optional().describe('본문에 남길 설명 (마크다운, [[링크]] 가능)'),
  user_confirmed: confirmed,
};

export const updateShape = {
  id: nodeId.describe('decision-... 노드 id'),
  actual_outcome: z.string().min(4),
  variance: z.string().min(2).describe('기대와 실제의 괴리'),
  lesson: z.string().min(10).describe('결과가 아니라 프로세스에 대한 교훈'),
  verdict: z.enum(['맞음', '틀림', '부분적', '판정불가']),
  resulted_in: z.array(nodeId).default([]).describe('결과를 보여준 Event 노드 id'),
  closed_at: day.optional(),
  note: z.string().optional().describe('본문 끝에 덧붙일 회고'),
  user_confirmed: confirmed,
};

// 판단일은 한국 날짜다 — UTC 로 계산하면 오전 9시 전 판단이 전날로 찍힌다
const KST = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
export const today = () => KST.format(new Date());

/** 닫힌 판단: status 가 closed 이거나 결과가 이미 적혀 있다 (status 없이 손으로 쓴 페이지도 있다) */
export const isClosed = (status, decision) => status === 'closed' || decision?.actual_outcome != null;

/** 참조된 노드 중 위키에 없는 것 */
function missingRefs(wiki, ids) {
  return [...new Set(ids)].filter((id) => !wiki.has(id));
}

export function recordDecision(wiki, input) {
  const d = z.object(recordShape).parse(input);
  wiki.assertWritable();
  const date = d.date ?? today();
  const id = `decision-${d.slug}-${date}`;
  const path = join(wiki.pagesDir, `${id}.md`);
  if (existsSync(path)) throw new Error(`이미 있는 판단: ${id} — 결과 기록은 decision_update 를 쓴다`);

  const missing = missingRefs(wiki, [...d.about, ...d.triggered_by]);
  if (missing.length) {
    throw new Error(`위키에 없는 노드: ${missing.join(', ')} — 엔티티/이벤트 페이지를 먼저 만들고(사용자 확인 후) 다시 호출한다`);
  }

  const fm = {
    id,
    type: 'Decision',
    title: d.title,
    date,
    tags: d.tags,
    status: 'open',
    decision: {
      action: d.action,
      thesis: d.thesis,
      confidence: d.confidence,
      expected_outcome: d.expected_outcome,
      ...(d.expected_probability != null && { expected_probability: d.expected_probability }),
      invalidation_condition: d.invalidation_condition,
      time_horizon: d.time_horizon,
      ...(d.emotion && { emotion: d.emotion }),
    },
    edges: [
      ...d.triggered_by.map((to) => ({ rel: 'triggered-by', to })),
      // 'affects'가 아니라 'about' — 결정은 종목에 "영향을 주는" 것이 아니라 "대상으로 하는" 것이다.
      ...d.about.map((to) => ({ rel: 'about', to })),
    ],
  };
  const body = d.note ?? `${d.about.map((a) => `[[${a}]]`).join(', ')}에 대한 판단.`;
  writeFileSync(path, `---\n${stringify(fm).trimEnd()}\n---\n\n${body.trim()}\n`, { flag: 'wx' });
  return { id, path, status: 'open' };
}

export function updateDecision(wiki, input) {
  const u = z.object(updateShape).parse(input);
  wiki.assertWritable();
  const path = join(wiki.pagesDir, `${u.id}.md`);
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error(`없는 판단: ${u.id}`);
  }
  if (!st.isFile()) throw new Error(`일반 파일이 아님 (링크 금지): ${u.id}`);

  const raw = readFileSync(path, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`프론트매터 없음: ${u.id}`);
  const doc = parseDocument(m[1]);
  if (doc.get('type') !== 'Decision') throw new Error(`Decision 페이지가 아님: ${u.id}`);
  if (isClosed(doc.get('status'), doc.toJS().decision)) throw new Error(`이미 결과가 기록된 판단: ${u.id}`);

  const missing = missingRefs(wiki, u.resulted_in);
  if (missing.length) throw new Error(`위키에 없는 노드: ${missing.join(', ')} — 결과 이벤트 페이지를 먼저 만든다`);

  const closedAt = u.closed_at ?? today();
  doc.setIn(['decision', 'actual_outcome'], u.actual_outcome);
  doc.setIn(['decision', 'variance'], u.variance);
  doc.setIn(['decision', 'lesson'], u.lesson);
  doc.setIn(['decision', 'verdict'], u.verdict);
  doc.set('status', 'closed');
  doc.set('closed_at', closedAt);
  if (!doc.has('edges')) doc.set('edges', doc.createNode([]));
  for (const to of u.resulted_in) doc.get('edges').add(doc.createNode({ rel: 'resulted-in', to }));

  const body = u.note ? `${m[2].trimEnd()}\n\n**결과 (${closedAt}): ${u.verdict}.** ${u.note.trim()}\n` : m[2];
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `---\n${doc.toString().trimEnd()}\n---\n${body.startsWith('\n') ? '' : '\n'}${body}`, { flag: 'wx' });
  renameSync(tmp, path);
  return { id: u.id, status: 'closed', verdict: u.verdict };
}

/** 열린 판단 목록 — 브리핑의 무효화 조건 점검 입력 */
export function openDecisions(db) {
  return db
    .prepare(`SELECT id, title, date, status, payload FROM nodes WHERE type = 'Decision' ORDER BY date DESC`)
    .all()
    .map(({ payload, ...r }) => ({ ...r, decision: JSON.parse(payload ?? '{}') }))
    .filter((r) => !isClosed(r.status, r.decision));
}
