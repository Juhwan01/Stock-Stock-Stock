import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildIndex, createWiki, search, traverse, findSimilarCases } from '../lib/wiki.mjs';
import { tempWiki } from './helpers.mjs';

const pages = () => join(tempWiki(), 'pages');

test('한국어 부분어는 trigram MATCH 로 찾는다 — "하이닉스" → SK하이닉스', () => {
  const { db } = buildIndex(pages());
  const r = search(db, '하이닉스');
  assert.equal(r.mode, 'FTS5 trigram MATCH');
  assert.ok(r.rows.some((x) => x.id === 'company-sk-hynix'));
});

test('2글자 쿼리는 LIKE 로 폴백한다 — trigram 은 2글자 MATCH 불가', () => {
  const { db } = buildIndex(pages());
  const r = search(db, '실적');
  assert.match(r.mode, /LIKE/);
  assert.ok(r.rows.length > 0);
});

test('FTS 문법 문자가 섞인 입력도 구문 오류 없이 검색된다', () => {
  const { db } = buildIndex(pages());
  assert.doesNotThrow(() => search(db, 'HBM3E "수요" (전망) OR -NOT'));
});

test('바이템포럴 — 반증된 영향 관계는 그 이전 시점에만 보인다', () => {
  const { db } = buildIndex(pages());
  const at = (asOf) => traverse(db, 'company-sk-hynix', { hops: 1, rels: ['affects'], asOf }).map((r) => r.id);
  assert.ok(at('2024-09-01').includes('event-blackwell-delay-2024'));
  assert.ok(!at('2026-08-19').includes('event-blackwell-delay-2024'));
  assert.ok(at('2026-08-19').includes('event-rubin-delay-rumor-2026'));
});

test('유사 케이스 — 루빈 루머에서 2024 비중축소 판단과 교훈을 소환한다', () => {
  const { db } = buildIndex(pages());
  const [top] = findSimilarCases(db, 'event-rubin-delay-rumor-2026');
  assert.equal(top.id, 'decision-hynix-reduce-2024');
  assert.match(top.decision.lesson, /부품사/);
  assert.equal(top.payload, undefined, '원시 payload 는 decision 으로 풀어서 내보낸다');
});

test('프론트매터 없는 파일 하나가 인덱스 전체를 죽이지 않는다', () => {
  const dir = pages();
  writeFileSync(join(dir, 'README.md'), '# 그냥 메모\n');
  const { stats } = buildIndex(dir);
  assert.equal(stats.nodes, 7);
  assert.deepEqual(stats.invalid.map((x) => x.file), ['README.md']);
});

test('없는 노드를 가리키는 링크와 스키마 밖 관계를 보고한다', () => {
  const dir = pages();
  writeFileSync(
    join(dir, 'event-x.md'),
    '---\nid: event-x\ntype: Event\ntitle: 테스트\ndate: 2026-01-01\nedges:\n  - rel: afects\n    to: company-nowhere\n---\n[[theme-nowhere]]\n',
  );
  const { stats } = buildIndex(dir);
  const targets = stats.dangling.map((d) => d.to);
  assert.ok(targets.includes('company-nowhere') && targets.includes('theme-nowhere'));
  assert.deepEqual(stats.unknownRels, [{ from: 'event-x', rel: 'afects' }]);
});

test('에이전트가 파일을 직접 고치면 다음 조회에서 인덱스가 다시 만들어진다', () => {
  const dir = pages();
  const wiki = createWiki(dir);
  const first = wiki.get();
  assert.equal(first.stats.nodes, 7);
  assert.equal(wiki.get(), first, '변화가 없으면 재구축하지 않는다');
  writeFileSync(join(dir, 'theme-new.md'), '---\nid: theme-new\ntype: Theme\ntitle: 새 테마\n---\n본문\n');
  assert.equal(wiki.get().stats.nodes, 8);
  assert.ok(wiki.has('theme-new'));
});

test('pages/ 가 아직 없으면 빈 위키로 동작한다', () => {
  const wiki = createWiki(join(tempWiki(), 'nope'));
  assert.equal(wiki.get().stats.nodes, 0);
});

// ── 코드 리뷰 재현 케이스 ───────────────────────────────────────
const page = (dir, id, fm, body = '본문') => writeFileSync(join(dir, `${id}.md`), `---\nid: ${id}\n${fm}\n---\n${body}\n`);

test('LLM 이 쓰기 쉬운 틀린 엣지·필드가 있어도 인덱스가 살아 있고, 무엇이 틀렸는지 보고한다', () => {
  const dir = pages();
  page(dir, 'event-a', 'type: Event\ntitle: A\ndate: 2026-01-01\nsources:\n  - url: https://x\n    title: 객체형 출처\nedges:\n  - rel: about\n    to: [[company-sk-hynix]]');
  page(dir, 'event-b', 'type: Event\ntitle: B\ndate: 2026-01-02\nsources: [https://y]\nedges:\n  - to: company-nvidia');
  page(dir, 'event-c', 'type: Event\ntitle: C\ndate: 2026-01-03\nsources: [https://z]\nedges:\n  rel: about\n  to: theme-hbm');
  page(dir, 'event-d', 'type: Event\ntitle: D\ndate: 2026-01-04\nsources: [https://w]\ntags: HBM\nedges:\n  - rel: about\n    to: theme-hbm\n    note:\n      why: 매핑형 메모');
  const { db, stats } = buildIndex(dir);
  assert.equal(stats.nodes, 11, '네 페이지 모두 노드로 들어간다');
  assert.deepEqual(stats.invalid, []);
  assert.equal(stats.badEdges.length, 3, 'to: [[x]] · rel 없음 · edges 가 매핑');
  assert.ok(db.prepare(`SELECT 1 FROM edges WHERE src = 'event-d' AND rel = 'about'`).get(), '매핑형 note 는 문자열로 남긴다');
  assert.deepEqual(JSON.parse(db.prepare(`SELECT tags FROM nodes WHERE id = 'event-d'`).get().tags), ['HBM']);
  assert.ok(search(db, '하이닉스').rows.length > 0, '검색도 계속 된다');
});

test('인덱스 재구축이 실패하는 동안에도, 고친 뒤에도 서버가 계속 답한다', () => {
  const dir = pages();
  const wiki = createWiki(dir);
  wiki.get();
  page(dir, 'event-bad', 'type: Event\ntitle: 나쁨\nedges:\n  - rel: about\n    to: [[x]]');
  assert.doesNotThrow(() => wiki.get());
  rmSync(join(dir, 'event-bad.md'));
  assert.equal(wiki.get().stats.nodes, 7, '고친 뒤 닫힌 DB 를 돌려주지 않는다');
  assert.ok(wiki.has('company-sk-hynix'));
});

test('필수 필드 누락과 따옴표 없는 종목코드를 보고한다', () => {
  const dir = pages();
  page(dir, 'company-x', 'type: Company\ntitle: X\nticker: 000660');
  page(dir, 'decision-y', 'type: Decision\ntitle: Y\ndate: 2026-01-01\ndecision:\n  action: 매수');
  const issues = buildIndex(dir).stats.schemaIssues.map((i) => `${i.id}: ${i.issue}`);
  assert.ok(issues.some((i) => /company-x: ticker/.test(i)), '000660 은 YAML 에서 숫자 660 이 된다');
  assert.ok(issues.some((i) => /decision-y: decision\.thesis/.test(i)));
});

test('심볼릭 링크 페이지는 읽지 않는다', () => {
  const dir = pages();
  symlinkSync(join(dir, 'theme-hbm.md'), join(dir, 'theme-link.md'));
  const { stats } = buildIndex(dir);
  assert.equal(stats.nodes, 7);
  assert.match(stats.invalid.find((x) => x.file === 'theme-link.md').error, /링크/);
});

test('LIKE 폴백에서 % 와 _ 는 글자 그대로 찾는다', () => {
  const { db } = buildIndex(pages());
  assert.equal(search(db, '%').rows.length, 0, '예전엔 모든 페이지가 나왔다');
});

test('태그가 없어도 similar-to 링크만으로 과거 판단을 소환한다', () => {
  const dir = pages();
  page(dir, 'event-untagged', 'type: Event\ntitle: 태그 없는 지연 루머\ndate: 2026-09-01\nsources: [https://x]\nedges:\n  - rel: similar-to\n    to: event-blackwell-delay-2024');
  const hits = findSimilarCases(buildIndex(dir).db, 'event-untagged');
  assert.equal(hits[0]?.id, 'decision-hynix-reduce-2024');
});

test('없는 노드 id 는 "선례 없음"이 아니라 오류다 — 오타를 선례 없음으로 읽지 않게', () => {
  const { db } = buildIndex(pages());
  assert.throws(() => findSimilarCases(db, 'event-typo'), /위키에 없는 노드/);
  assert.throws(() => traverse(db, 'company-typo'), /위키에 없는 노드/);
});
