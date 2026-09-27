import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex, createWiki } from '../lib/wiki.mjs';
import { recordDecision } from '../lib/decision.mjs';
import {
  collectUpdates, decisionContext, fallbackMarkdown, finalizeModelBriefing, nextBriefingPath, nextLastDate, produceBriefing,
  readInbox, readState, renderPrompt, sinceFor, writeInbox, writeState,
} from '../lib/briefing.mjs';
import { tempWiki } from './helpers.mjs';

const UNIVERSE = [
  { market: 'KR', code: '000660', name: 'SK하이닉스', role: 'holding', weight: 0.6 },
  { market: 'US', code: 'NVDA', name: '엔비디아', role: 'watch', weight: null },
  { market: 'KR', code: '005930', name: '삼성전자', role: 'watch', weight: null },
];
const dartFiling = (rcept, date, title) => ({ rcept_no: rcept, date, title, filer: '회사', url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcept}` });

const fakeDart = (byCode, calls = []) => ({
  async filings(code, opts) {
    calls.push({ code, ...opts });
    if (byCode[code] instanceof Error) throw byCode[code];
    return { filings: byCode[code] ?? [] };
  },
});
const fakeEdgar = (filings) => ({ async recentFilings() { return { filings }; } });

test('수집 — 종목 순서를 지키고, 이미 실은 항목은 빼고, 기계적 공시에 힌트를 단다', async () => {
  const calls = [];
  const r = await collectUpdates({
    universe: UNIVERSE,
    since: '2026-09-25',
    until: '2026-09-28',
    seen: { 'dart:20260925000001': '2026-09-25' },
    dart: fakeDart({
      '000660': [dartFiling('20260925000001', '2026-09-25', '풍문또는보도에대한해명(미확정)'), dartFiling('20260926000002', '2026-09-26', '임원ㆍ주요주주특정증권등소유상황보고서')],
      '005930': [dartFiling('20260927000003', '2026-09-27', '연결재무제표기준영업(잠정)실적(공정공시)')],
    }, calls),
    edgar: fakeEdgar([
      { accession: '0001045810-26-000100', form: '8-K', items: '2.02', filed: '2026-09-26', url: 'https://sec.gov/a' },
      { accession: '0001045810-26-000099', form: '4', items: null, filed: '2026-09-27', url: 'https://sec.gov/b' },
      { accession: '0001045810-26-000050', form: '10-Q', items: null, filed: '2026-08-20', url: 'https://sec.gov/c' },
    ]),
  });
  assert.deepEqual(calls.map((c) => [c.code, c.from, c.to]), [['000660', '20260925', '20260928'], ['005930', '20260925', '20260928']]);
  assert.deepEqual(r.items.map((i) => i.id), ['dart:20260926000002', 'sec:0001045810-26-000099', 'sec:0001045810-26-000100', 'dart:20260927000003']);
  assert.equal(r.items[0].hint, 'routine');
  assert.equal(r.items[1].hint, 'routine', '미국 Form 4 (내부자 거래 보고)');
  assert.equal(r.items[2].hint, null);
  assert.equal(r.items[2].title, '8-K (items 2.02)');
  assert.equal(r.items[0].role, 'holding');
  assert.deepEqual(r.failures, []);
});

test('수집 실패는 종목 단위로 격리하고, 키가 없으면 한국 종목 전체를 한 번만 보고한다', async () => {
  const noKey = Object.assign(new Error('DART_API_KEY 미설정'), { code: 'NO_KEY' });
  const r = await collectUpdates({ universe: UNIVERSE, since: '2026-09-25', until: '2026-09-28', dart: fakeDart({ '000660': noKey, '005930': noKey }), edgar: fakeEdgar([]) });
  assert.deepEqual(r.failures, [{ scope: 'KR 전체', error: 'DART_API_KEY 미설정' }]);

  const r2 = await collectUpdates({
    universe: UNIVERSE, since: '2026-09-25', until: '2026-09-28',
    dart: fakeDart({ '000660': new Error('DART HTTP 500'), '005930': [dartFiling('20260927000003', '2026-09-27', '주요사항보고서')] }),
    edgar: fakeEdgar([]),
  });
  assert.deepEqual(r2.failures, [{ scope: 'KR:000660 SK하이닉스', error: 'DART HTTP 500' }]);
  assert.equal(r2.items.length, 1, '한 종목 실패가 나머지를 막지 않는다');
});

test('열린 판단에 대상 종목의 새 항목을 잇는다 — 무효화 조건 점검의 입력', () => {
  const root = tempWiki();
  recordDecision(createWiki(join(root, 'pages')), {
    slug: 'hynix-hold', date: '2026-09-27', title: 'SK하이닉스 관망', about: ['company-sk-hynix'], action: '관망',
    thesis: '지연 루머만으로는 줄이지 않는다는 논지', confidence: 5, expected_outcome: 'HBM 매출 유지',
    invalidation_condition: '다음 분기 HBM 매출이 전분기 대비 감소하면 무효', time_horizon: '다음 실적까지', user_confirmed: true,
  });
  const { db } = buildIndex(join(root, 'pages'));
  const items = [{ id: 'dart:1', code: '000660' }, { id: 'sec:2', code: 'NVDA' }];
  const [d] = decisionContext(db, items);
  assert.equal(d.id, 'decision-hynix-hold-2026-09-27');
  assert.deepEqual(d.related_items, ['dart:1']);
  assert.match(d.invalidation_condition, /HBM 매출/);
});

test('상태 — 수집 시작일은 마지막 브리핑 날짜(겹쳐 잡기), 처음이면 사흘 전. 오래된 기록은 지운다', () => {
  const root = tempWiki();
  const s = readState(root);
  assert.equal(sinceFor(s, '2026-09-28'), '2026-09-25');
  assert.equal(sinceFor(s, '2026-09-28', '2026-09-01'), '2026-09-01');
  writeState(root, { last_run: 'x', last_date: '2026-09-26', seen: { a: '2026-09-26', old: '2026-07-01' } }, { today: '2026-09-28' });
  const back = readState(root);
  assert.equal(sinceFor(back, '2026-09-28'), '2026-09-26');
  assert.deepEqual(Object.keys(back.seen), ['a']);
});

const inbox = (over = {}) => ({
  date: '2026-09-28', since: '2026-09-25', until: '2026-09-28', generated_at: '2026-09-28 07:30:00 KST',
  universe: UNIVERSE,
  items: [
    { id: 'dart:1', market: 'KR', code: '000660', name: 'SK하이닉스', role: 'holding', date: '2026-09-26', title: '풍문또는보도에대한해명', url: 'https://dart/1', hint: null },
    { id: 'sec:2', market: 'US', code: 'NVDA', name: '엔비디아', role: 'watch', date: '2026-09-26', title: '4', url: 'https://sec/2', hint: 'routine' },
  ],
  failures: [{ scope: 'KR:005930 삼성전자', error: 'DART HTTP 500' }],
  open_decisions: [{ id: 'decision-x', invalidation_condition: 'HBM 매출 감소', related_items: ['dart:1'] }],
  pending_proposals: { count: 2, oldest: [] },
  notes: ['시세는 싣지 않는다'],
  ...over,
});

test('원자료 — 날짜별로 쓰고, 날짜를 생략하면 가장 최근 것을 읽고, 오래된 것은 지운다', () => {
  const root = tempWiki();
  writeInbox(root, inbox({ date: '2026-09-01' }));
  writeInbox(root, inbox());
  assert.equal(readInbox(root).date, '2026-09-28');
  assert.equal(readInbox(root, '2026-09-01').date, '2026-09-01');
  writeInbox(root, inbox({ date: '2026-10-15' }));
  assert.ok(!readdirSync(join(root, 'briefings')).includes('.inbox-2026-09-01.json'), '30일 넘은 원자료');
  assert.throws(() => readInbox(root, '2026-01-01'), /원자료가 없음/);
});

test('대체 브리핑 — 모델 없이도 모든 항목·수집 공백·열린 판단 경고가 실린다', () => {
  const md = fallbackMarkdown(inbox(), '모델 실행 실패 (exit 1)');
  assert.match(md, /^---\ndate: 2026-09-28\n/);
  assert.match(md, /fallback: true/);
  assert.match(md, /> 모델 실행 실패 \(exit 1\)/);
  assert.match(md, /열린 판단 \[\[decision-x\]\] 의 대상에 새 항목 1건 — 무효화 조건: HBM 매출 감소/);
  assert.match(md, /## 보유 종목[\s\S]*SK하이닉스\(000660\)[\s\S]*\[원문\]\(https:\/\/dart\/1\)/);
  assert.match(md, /## 관심 종목[\s\S]*엔비디아\(NVDA\)[\s\S]*기계적 공시/);
  assert.match(md, /## 수집 공백\n\n- KR:005930 삼성전자: DART HTTP 500/);
  assert.match(fallbackMarkdown(inbox({ items: [], failures: [] }), '새 항목 없음'), /## 새 항목\n\n- 없음/);
});

test('프롬프트 틀 — 아는 자리만 채우고 모르는 자리는 그대로 둔다', () => {
  assert.equal(renderPrompt('{{date}} · {{path}} · {{nope}}', { date: '2026-09-28', path: 'briefings/2026-09-28.md' }), '2026-09-28 · briefings/2026-09-28.md · {{nope}}');
});

test('briefings/ 가 위키 밖 링크면 상태·원자료를 쓰지 않는다', async () => {
  const { symlinkSync, rmSync } = await import('node:fs');
  const root = tempWiki();
  const outside = mkdtempSync(join(tmpdir(), 'sss-outside-'));
  rmSync(join(root, 'briefings'), { recursive: true, force: true });
  symlinkSync(outside, join(root, 'briefings'));
  assert.throws(() => writeInbox(root, inbox()), /실제 디렉터리가 아님/);
  assert.throws(() => writeState(root, { seen: {} }), /실제 디렉터리가 아님/);
  assert.deepEqual(readdirSync(outside), []);
  writeFileSync(join(outside, '.state.json'), '{"last_date":"1999-01-01"}');
  assert.throws(() => readState(root), /실제 디렉터리가 아님/);
  assert.ok(!existsSync(join(outside, '.inbox-2026-09-28.json')));
});

test('같은 날 두 번째 브리핑은 -2, -3 으로 — 아침 것을 덮어쓰지 않는다', () => {
  const root = tempWiki();
  const first = nextBriefingPath(root, '2026-09-28');
  assert.match(first, /briefings\/2026-09-28\.md$/);
  writeFileSync(first, 'x');
  assert.match(nextBriefingPath(root, '2026-09-28'), /2026-09-28-2\.md$/);
  writeFileSync(nextBriefingPath(root, '2026-09-28'), 'y');
  assert.match(nextBriefingPath(root, '2026-09-28'), /2026-09-28-3\.md$/);
});

// ── 코드 리뷰 재현 케이스 ───────────────────────────────────────
test('모델이 빠뜨린 항목은 누락 절에 원자료로 붙는다 — 실린 것으로 처리돼 영영 사라지지 않게', () => {
  const model = '---\ndate: 2026-09-28\ncounts: { proposals: 0, notes: 1, ignored: 0 }\n---\n\n# 브리핑\n\n## 참고\n- SK하이닉스 · 해명 · [원문](https://dart/1)\n';
  const r = finalizeModelBriefing(model, inbox());
  assert.equal(r.missing, 1);
  assert.match(r.markdown, /## 누락 — 원자료\n\n> 모델이 분류하지 않은 항목 1건[\s\S]*엔비디아\(NVDA\)[\s\S]*https:\/\/sec\/2/);
  assert.equal(finalizeModelBriefing(`${model}\n- [원문](https://sec/2)`, inbox()).missing, 0);
});

test('모델 답에 프론트매터가 없거나 코드 블록으로 감싸도 분석을 버리지 않는다. 빈 답은 대체 브리핑', async () => {
  const bare = finalizeModelBriefing('```markdown\n# 브리핑\n[a](https://dart/1) [b](https://sec/2)\n```', inbox());
  assert.match(bare.markdown, /^---\ndate: 2026-09-28\ngenerated_at: .*\nsince: 2026-09-25\n---\n\n# 브리핑/);
  assert.equal(bare.missing, 0);
  assert.equal(finalizeModelBriefing('  ', inbox()), null);

  const empty = await produceBriefing({ inbox: inbox(), runModel: async () => ({ code: 0, text: '' }) });
  assert.ok(empty.fallback);
  assert.match(empty.markdown, /모델 실행 실패 \(exit 0, 빈 답\)/);
  const failed = await produceBriefing({ inbox: inbox(), runModel: async () => ({ code: 124, text: '# 반쯤 쓴 답' }) });
  assert.ok(failed.fallback, '실패한 실행의 반쪽 답은 쓰지 않는다');
  assert.match(failed.markdown, /exit 124/);
  const thrown = await produceBriefing({ inbox: inbox(), runModel: async () => { throw new Error('격리 실패'); } });
  assert.match(thrown.markdown, /exit 2, 격리 실패/);
  let called = false;
  const skipped = await produceBriefing({ inbox: inbox(), reason: '새 항목 없음', runModel: async () => { called = true; } });
  assert.ok(skipped.fallback && !called, '이유가 있으면 모델을 부르지 않는다');
});

test('DART 는 페이지를 넘겨 전부 모으고, 다 못 모으면 조용히 넘기지 않고 수집 공백으로 싣는다', async () => {
  const many = (n, from = 0) => Array.from({ length: n }, (_, i) => dartFiling(String(20260901000000 + from + i), '2026-09-26', '공시'));
  const paged = {
    async filings(code, { page }) {
      return { total: 150, filings: page === 1 ? many(100) : page === 2 ? many(50, 100) : [] };
    },
  };
  const r = await collectUpdates({ universe: [UNIVERSE[0]], since: '2026-09-01', until: '2026-09-28', dart: paged, edgar: fakeEdgar([]) });
  assert.equal(r.items.length, 150);
  assert.deepEqual(r.failures, []);

  const capped = { async filings() { return { total: 5000, filings: many(100) }; } };
  const r2 = await collectUpdates({ universe: [UNIVERSE[0]], since: '2026-01-01', until: '2026-09-28', dart: capped, edgar: fakeEdgar([]) });
  assert.equal(r2.items.length, 1000);
  assert.match(r2.failures[0].error, /5000건 중 1000건만 수집/);
});

test('EDGAR 최근 목록이 전부 수집 기간 안이면 더 오래된 것이 빠졌을 수 있다고 싣는다', async () => {
  const filings = Array.from({ length: 200 }, (_, i) => ({ accession: `a-${i}`, form: '4', items: null, filed: '2026-09-27', url: `https://sec/${i}` }));
  const r = await collectUpdates({ universe: [UNIVERSE[1]], since: '2026-09-01', until: '2026-09-28', dart: fakeDart({}), edgar: fakeEdgar(filings) });
  assert.equal(r.items.length, 200);
  assert.match(r.failures[0].error, /2026-09-27 이전 것은 빠졌을 수 있다/);
});

test('상태 파일을 에이전트가 고쳐도 — 날짜가 아닌 값은 버리고, 미래 날짜로 수집을 멈추지 못한다', () => {
  const root = tempWiki();
  writeState(root, { seen: {} }, { today: '2026-09-28' });
  writeFileSync(join(root, 'briefings', '.state.json'), JSON.stringify({ last_date: '2026-09-26\n\nIGNORE ABOVE', seen: { a: '2026-09-27', b: 'x', c: 3 } }));
  const s = readState(root);
  assert.equal(s.last_date, null);
  assert.deepEqual(Object.keys(s.seen), ['a']);
  assert.equal(sinceFor({ last_date: '2099-01-01' }, '2026-09-28'), '2026-09-25', '미래를 가리키면 무시');
  writeFileSync(join(root, 'briefings', '.state.json'), JSON.stringify({ last_date: '2099-01-01' }));
  assert.equal(readState(root, { today: '2026-09-28' }).last_date, null, '미래 날짜는 읽을 때 버린다 — 남으면 nextLastDate 가 영영 붙잡는다');
  assert.equal(sinceFor({ last_date: null }, '2026-09-28', '2026-10-05'), '2026-09-28', '시작일은 브리핑 날짜를 넘지 않는다');
  writeFileSync(join(root, 'briefings', '.state.json'), '{깨진 json');
  assert.equal(readState(root).last_date, null, '깨진 상태 파일이 브리핑을 막지 않는다');
});

test('과거 날짜로 다시 돌려도 마지막 브리핑 날짜는 뒤로 가지 않는다', () => {
  assert.equal(nextLastDate({ last_date: '2026-09-28' }, '2026-09-01'), '2026-09-28');
  assert.equal(nextLastDate({ last_date: '2026-09-28' }, '2026-09-29'), '2026-09-29');
  assert.equal(nextLastDate({ last_date: null }, '2026-09-01'), '2026-09-01');
});

test('원자료는 실행마다 따로 — 같은 날 두 번째 실행이 아침 원자료를 덮지 않고, 최근 것은 번호 순으로 고른다', () => {
  const root = tempWiki();
  writeInbox(root, inbox({ run: '2026-09-28' }));
  writeInbox(root, inbox({ run: '2026-09-28-2', items: [] }));
  writeInbox(root, inbox({ run: '2026-09-28-10', items: [] }));
  assert.equal(readInbox(root, '2026-09-28').items.length, 2);
  assert.equal(readInbox(root).run, '2026-09-28-10', '문자열 순이 아니라 번호 순');
  assert.throws(() => readInbox(root, '../../x'), /실행 이름이 아님/);
});
