import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tempWiki } from './helpers.mjs';
import { dartLatest, edgarCurrent, parseEdgarAtom, parseRss } from '../lib/feeds.mjs';
import {
  acquireWatchLock, cadence, createWatcher, matchNews, queryAlerts, readRecords, readWatchState, requestStop, scrubLinks, updateWatchSettings, watchDigest,
  watchSettings, watchStatus, watchTargets, WATCH_DEFAULTS,
} from '../lib/watch.mjs';
import { confirmLink, createTelegram, push, startLink, telegramStatus, unlink } from '../lib/telegram.mjs';
import { readSettings } from '../lib/settings.mjs';
import { recordDecision } from '../lib/decision.mjs';
import { createWiki } from '../lib/wiki.mjs';
import { fallbackMarkdown } from '../lib/briefing.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = (body) => new Response(body);
// 2026-09-30(수) 10:00 KST — DART 가 20초로 도는 시간
const T0 = Date.parse('2026-09-30T01:00:00Z');

const dartRow = (n, code, title, name = '회사') => ({
  corp_code: '0', corp_name: name, stock_code: code, corp_cls: 'Y', report_nm: title, rcept_no: `20260930${String(n).padStart(6, '0')}`,
  flr_nm: name, rcept_dt: '20260930', rm: '',
});
const atomEntry = (acc, form, company, cik, role = 'Filer') => `<entry>
<title>${form} - ${company} (${cik}) (${role})</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/1/${acc.replace(/-/g, '')}/${acc}-index.htm"/>
<updated>2026-09-29T21:59:04-04:00</updated>
<category scheme="https://www.sec.gov/" label="form type" term="${form}"/>
<id>urn:tag:sec.gov,2008:accession-number=${acc}</id>
</entry>`;
const rss = (items) => `<?xml version="1.0"?><rss><channel><title>t</title>${items
  .map((i) => `<item><title><![CDATA[${i.title}]]></title><link><![CDATA[${i.link}]]></link><pubDate>${i.pubDate ?? 'Wed, 30 Sep 2026 09:50:00 +0900'}</pubDate></item>`)
  .join('')}</channel></rss>`;

/** 보유 SK하이닉스 · 관심 삼성전자 · 관심 엔비디아 + 하이닉스 대상의 열린 판단 */
function setup({ decision = true } = {}) {
  const root = tempWiki();
  writeFileSync(join(root, 'portfolio.yaml'), `watchlist:
  - { market: KR, code: "005930", name: 삼성전자 }
  - { market: US, code: NVDA, name: 엔비디아 }
holdings:
  - { market: KR, code: "000660", name: SK하이닉스, quantity: 10, avg_price: 100000 }
`);
  const wiki = createWiki(join(root, 'pages'), { root });
  if (decision) {
    recordDecision(wiki, {
      slug: 'hynix-hold', date: '2026-09-27', title: 'SK하이닉스 관망', about: ['company-sk-hynix'], action: '관망',
      thesis: '지연 루머만으로는 줄이지 않는다', confidence: 5, expected_outcome: 'HBM 매출 유지',
      invalidation_condition: '다음 분기 HBM 매출이 전분기 대비 감소하면 무효', time_horizon: '다음 실적까지', user_confirmed: true,
    });
  }
  const varDir = tmp('sss-watch-var-');
  return { root, wiki, varDir, settingsFile: join(varDir, 'settings.json') };
}

/** 가짜 인터넷 — 소스별 응답을 테스트가 바꿔 끼운다 */
function fakeNet() {
  const net = { dart: [], edgar: '', news: [], calls: [] };
  net.fetch = async (url) => {
    net.calls.push(String(url));
    if (url.includes('opendart')) return json({ status: '000', total_page: 1, list: net.dart });
    if (url.includes('getcurrent')) return text(`<feed>${net.edgar}</feed>`);
    if (url.includes('news.test')) return text(rss(net.news));
    throw new Error(`예상 못 한 요청: ${url}`);
  };
  return net;
}

function watcher(ctx, net, extra = {}) {
  const sent = [];
  const clock = { t: T0 };
  const w = createWatcher({
    root: ctx.root, varDir: ctx.varDir, settingsFile: ctx.settingsFile, wiki: ctx.wiki, fetch: net.fetch,
    env: { DART_API_KEY: 'k' }, now: () => clock.t,
    dart: { filings: async () => ({ filings: [] }) },
    edgar: { cikOf: async (t) => ({ cik: t === 'NVDA' ? '0001045810' : '0000000001' }), recentFilings: async () => ({ company: 'NVIDIA CORP', filings: [] }) },
    feeds: [{ name: '테스트뉴스', url: 'https://news.test/rss' }],
    notify: async (m) => {
      sent.push(m);
      return { via: 'telegram' };
    },
    ...extra,
  });
  return {
    w, sent, clock,
    alerts: () => sent.filter((m) => !m.title.includes('감시 공백')),
    // 깨어 있는 시간 — 박동 타이머가 10초마다 제때 온다
    advance: (ms) => {
      for (let left = ms; left > 0; left -= 10e3) {
        clock.t += Math.min(10e3, left);
        w.beat();
      }
    },
    // 맥이 잠든 시간 — 타이머가 멈춰 있다가 깨어날 때 한 번 늦게 온다
    sleep: (ms) => {
      clock.t += ms;
      w.beat();
    },
  };
}

// ── 원천 파서 ────────────────────────────────────────────────────
test('RSS — CDATA 링크·엔티티를 풀고, 링크 없는 항목은 버린다', () => {
  const items = parseRss(`<rss><channel><item><title><![CDATA[삼성전자 &amp; SK하이닉스]]></title><link><![CDATA[https://a.test/1]]></link>
    <pubDate>Wed, 30 Sep 2026 13:00:04 +0900</pubDate></item><item><title>링크 없음</title></item>
    <item><title>가이드</title><guid>https://a.test/2</guid></item></channel></rss>`);
  assert.deepEqual(items.map((i) => [i.title, i.link]), [['삼성전자 & SK하이닉스', 'https://a.test/1'], ['가이드', 'https://a.test/2']]);
  assert.equal(items[0].published, '2026-09-30T04:00:04.000Z');
});

test('EDGAR Atom — 양식·회사·CIK·역할·접수번호를 읽는다 (한 공시가 역할마다 한 줄)', () => {
  const xs = parseEdgarAtom(atomEntry('0001-26-1', '8-K', 'NVIDIA CORP', '0001045810') + atomEntry('0001-26-1', '8-K', 'Smith John', '0000000009', 'Reporting'));
  assert.deepEqual(xs.map((x) => [x.accession, x.form, x.company, x.cik, x.role]), [
    ['0001-26-1', '8-K', 'NVIDIA CORP', '0001045810', 'Filer'], ['0001-26-1', '8-K', 'Smith John', '0000000009', 'Reporting'],
  ]);
  assert.match(xs[0].url, /^https:\/\/www\.sec\.gov\//);
});

test('DART 전체 목록 — 본 항목이 나온 페이지에서 멈추고, 끝까지 못 만나면 잘렸다고 알린다', async () => {
  const pages = { 1: [dartRow(5, '000660', 'e'), dartRow(4, '000660', 'd')], 2: [dartRow(3, '000660', 'c'), dartRow(2, '000660', 'b')], 3: [dartRow(1, '000660', 'a')] };
  const calls = [];
  const fetch = async (url) => {
    const page = Number(new URL(url).searchParams.get('page_no'));
    calls.push(page);
    return json({ status: '000', total_page: 3, list: pages[page] });
  };
  const seen = new Set(['dart:20260930000003']);
  const r = await dartLatest({ key: 'k', from: '2026-09-29', to: '2026-09-30', seen, pages: 5, fetch });
  assert.deepEqual(r.items.map((i) => i.title), ['e', 'd', 'b'], '본 것은 빼되 같은 페이지의 나머지는 싣는다');
  assert.deepEqual(calls, [1, 2]);
  assert.equal(r.truncated, false);
  const cut = await dartLatest({ key: 'k', from: '2026-09-29', to: '2026-09-30', seen: new Set(), pages: 2, fetch });
  assert.equal(cut.truncated, true);
  await assert.rejects(dartLatest({ key: '', from: 'a', to: 'b', fetch }), (e) => e.code === 'NO_KEY');
  const none = await dartLatest({ key: 'k', from: 'a', to: 'b', fetch: async () => json({ status: '013', message: '없음' }) });
  assert.deepEqual(none, { items: [], truncated: false });
});

test('EDGAR 최신 목록 — 본 공시를 만나면 멈추고 ISO-8859-1 로 읽는다', async () => {
  const body = Buffer.from(`<feed>${atomEntry('0002-26-1', '8-K', 'Caf\xe9 Corp', '0000000002')}${atomEntry('0001-26-1', '10-Q', 'Old', '0000000003')}</feed>`, 'latin1');
  let n = 0;
  const r = await edgarCurrent({ ua: 'x', seen: new Set(['sec:0001-26-1']), pages: 3, fetch: async () => (n++, new Response(body)) });
  assert.equal(n, 1);
  assert.deepEqual(r.entries.map((e) => e.company), ['Café Corp']);
});

// ── 대상 · 규칙 ──────────────────────────────────────────────────
test('감시 대상 — 보유(비중 순)·관심에 열린 판단이 붙고, 판단만 있는 종목도 대상이 된다', () => {
  const ctx = setup();
  recordDecision(ctx.wiki, {
    slug: 'nvda-watch', date: '2026-09-28', title: '엔비디아 관망', about: ['company-nvidia'], action: '관망',
    thesis: '루빈 일정이 확인될 때까지 지켜본다', confidence: 4, expected_outcome: '루빈 일정 유지 확인', invalidation_condition: '루빈 출하 연기 공시가 나오면 무효', time_horizon: '1개월', user_confirmed: true,
  });
  writeFileSync(join(ctx.root, 'portfolio.yaml'), 'holdings:\n  - { market: KR, code: "000660", name: SK하이닉스, quantity: 1, avg_price: 1 }\n');
  const ts = watchTargets({ portfolio: { watchlist: [], holdings: [{ market: 'KR', code: '000660', name: 'SK하이닉스', quantity: 1, avg_price: 1 }], cash: {} }, db: ctx.wiki.get().db });
  assert.deepEqual(ts.map((t) => [t.code, t.role, t.decisions.length]), [['000660', 'holding', 1], ['NVDA', 'decision', 1]]);
  assert.match(ts[0].decisions[0].invalidation_condition, /HBM 매출/);
});

test('뉴스 매칭 — 이름은 공백 무시, 미국 티커는 3자 이상·단어 경계만', () => {
  const targets = [
    { market: 'KR', code: '000660', name: 'SK 하이닉스', role: 'holding' },
    { market: 'US', code: 'NVDA', name: '엔비디아', role: 'watch' },
    { market: 'US', code: 'AI', name: 'C3.ai', role: 'watch' },
  ];
  const hits = matchNews([
    { title: 'SK하이닉스, HBM4 양산', link: 'u1', source: 's' },
    { title: 'NVDA shares jump', link: 'u2', source: 's' },
    { title: 'AI 인프라 투자 확대', link: 'u3', source: 's' },
    { title: 'NVDAX 라는 다른 이름', link: 'u4', source: 's' },
  ], targets);
  assert.deepEqual(hits.map((h) => [h.url, h.code]), [['u1', '000660'], ['u2', 'NVDA']]);
});

// ── 감시기 ───────────────────────────────────────────────────────
test('처음 한 바퀴는 기준선 — 이미 나온 공시는 기록만 하고, 그 뒤 새 공시만 민다 (열린 판단 표시)', async () => {
  const ctx = setup();
  const net = fakeNet();
  net.dart = [dartRow(1, '000660', '기업설명회(IR)개최'), dartRow(2, '999999', '남의 공시')];
  const { w, sent, advance } = watcher(ctx, net);
  await w.tick();
  assert.equal(sent.length, 0, '켜자마자 오늘 공시가 쏟아지지 않게');
  assert.equal(readRecords(ctx.varDir, '2026-09-30').filter((r) => r.type === 'alert' && r.reason === 'baseline').length, 1);

  net.dart = [dartRow(3, '000660', '주요사항보고서(유상증자결정)'), ...net.dart];
  advance(20e3);
  await w.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /^🔔 \[보유 100%\] SK하이닉스 — 주요사항보고서\(유상증자결정\)$/);
  assert.match(sent[0].text, /열린 판단 decision-hynix-hold-2026-09-27 의 대상 — 무효화 조건: 다음 분기 HBM/);
  assert.match(sent[0].text, /https:\/\/dart\.fss\.or\.kr\/dsaf001\/main\.do\?rcpNo=20260930000003/);
  assert.equal(sent[0].silent, false, '장중 공시는 소리 내서');

  advance(20e3);
  await w.tick();
  assert.equal(sent.length, 1, '같은 공시는 다시 보내지 않는다');
});

test('기계적 공시는 기록만, 한 번에 여섯 건 이상이면 한 통으로 묶는다, 밤에는 조용히', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const { w, alerts, advance, clock } = watcher(ctx, net);
  await w.tick(); // 기준선 (빈 목록)
  net.dart = [dartRow(10, '000660', '임원ㆍ주요주주특정증권등소유상황보고서')];
  advance(20e3);
  await w.tick();
  assert.equal(alerts().length, 0);
  assert.equal(readRecords(ctx.varDir, '2026-09-30').find((r) => r.id === 'dart:20260930000010').reason, 'routine');

  net.dart = Array.from({ length: 6 }, (_, i) => dartRow(20 + i, '005930', `단일판매ㆍ공급계약체결 ${i}`, '삼성전자'));
  clock.t = Date.parse('2026-09-30T14:00:00Z'); // 23:00 KST — 5분 간격
  await w.tick();
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].title, /공시 6건/);
  assert.equal(alerts()[0].silent, true);
});

test('보내기가 실패하면 기록해 두고 뒤로 미뤄 다시 보낸다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  let fail = true;
  const got = [];
  const { w, advance } = watcher(ctx, net, {
    notify: async (m) => (fail ? { via: null, error: 'down' } : (got.push(m), { via: 'telegram' })),
  });
  await w.tick();
  net.dart = [dartRow(3, '000660', '잠정실적(공정공시)')];
  advance(20e3);
  await w.tick();
  assert.equal(readRecords(ctx.varDir, '2026-09-30').find((r) => r.id === 'dart:20260930000003').push, 'retrying');
  fail = false;
  advance(10e3);
  await w.tick();
  assert.equal(got.length, 0, '30초 전에는 다시 보내지 않는다');
  advance(25e3);
  await w.tick();
  assert.equal(got.length, 1);
});

test('걸린 공시는 잠깐 모아 한 번에 해석하고, 해석을 뒤따라 보낸다 — 하루 한도를 넘으면 원문만', async () => {
  const ctx = setup();
  updateWatchSettings({ llm_daily_cap: 1 }, ctx.settingsFile);
  const net = fakeNet();
  const batches = [];
  const { w, sent, advance } = watcher(ctx, net, {
    interpret: async ({ batch, items }) => {
      batches.push({ batch, ids: items.map((i) => i.id), fromTool: queryAlerts(ctx.varDir, { batch }).items.map((i) => i.id) });
      return { code: 0, text: '■ SK하이닉스 · 유상증자\n- 핵심: …', model: 'luna · low' };
    },
  });
  await w.tick();
  net.dart = [dartRow(3, '000660', '주요사항보고서(유상증자결정)'), dartRow(4, '005930', '현금ㆍ현물배당결정', '삼성전자')];
  advance(20e3);
  await w.tick();
  assert.equal(batches.length, 0, '60초는 모은다');
  advance(60e3);
  await w.tick();
  await w.idle();
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].ids.sort(), batches[0].fromTool.sort(), '해석 모델은 도구로 같은 항목을 받는다');
  assert.match(batches[0].batch, /^2026-09-30-\d{6}$/);
  const interp = sent.find((m) => m.title.startsWith('🧠'));
  assert.match(interp.title, /SK하이닉스 외 1/);
  assert.match(interp.text, /모델 해석\(luna · low\)/);
  assert.equal(readRecords(ctx.varDir, '2026-09-30').filter((r) => r.type === 'interpretation' && r.ok).length, 1);

  net.dart = [dartRow(5, '000660', '투자판단관련주요경영사항'), ...net.dart];
  advance(20e3);
  await w.tick();
  advance(60e3);
  await w.tick();
  await w.idle();
  assert.equal(batches.length, 1, '하루 한도 1회');
  assert.ok(sent.some((m) => /해석 한도\(1회\)/.test(m.text)));
  assert.equal(w.state.llm.used, 1);
});

test('DART 원문이 아직 안 열렸으면 해석을 미루고(한도도 안 쓴다), 열리면 해석하고, 두 시간 넘게 안 열리면 건너뛴다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const ready = new Set();
  const batches = [];
  const { w, advance } = watcher(ctx, net, {
    dart: { filings: async () => ({ filings: [] }), documentReady: async (no) => ready.has(no) },
    interpret: async ({ items }) => (batches.push(items.map((i) => i.id)), { code: 0, text: '■ x', model: 'm' }),
  });
  await w.tick();
  net.dart = [dartRow(3, '000660', '잠정실적'), dartRow(4, '005930', '배당결정', '삼성전자')];
  advance(20e3);
  await w.tick();
  advance(60e3);
  await w.tick();
  await w.idle();
  assert.equal(batches.length, 0);
  assert.equal(w.state.llm.used, 0, '보류는 한도를 쓰지 않는다');
  ready.add('20260930000003');
  advance(30e3);
  await w.tick();
  await w.idle();
  assert.equal(batches.length, 0, '다시 보기는 1분 간격');
  advance(30e3);
  await w.tick();
  await w.idle();
  assert.deepEqual(batches, [['dart:20260930000003']], '열린 것만 먼저');
  advance(120 * 60e3);
  await w.tick();
  await w.idle();
  assert.equal(batches.length, 1, '두 시간 넘게 안 열린 공시는 해석하지 않는다');
  assert.ok(readRecords(ctx.varDir, '2026-09-30').some((r) => r.type === 'interpretation' && r.ids?.[0] === 'dart:20260930000004' && /원문 미반영/.test(r.error)));
  assert.equal(w.mem.queue.length, 0);
});

test('해석이 실패해도 원문 알림은 이미 갔고, 실패만 기록한다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const { w, sent, advance } = watcher(ctx, net, { interpret: async () => ({ code: 1, text: null, error: 'usage limit' }) });
  await w.tick();
  net.dart = [dartRow(3, '000660', '잠정실적')];
  advance(20e3);
  await w.tick();
  advance(60e3);
  await w.tick();
  await w.idle();
  assert.equal(sent.length, 1);
  assert.equal(readRecords(ctx.varDir, '2026-09-30').find((r) => r.type === 'interpretation').error, 'usage limit');
});

test('뉴스 — 기본은 보유·판단 대상만 조용히, 종목별 20분에 한 통, 오래된 기사는 기록만, 해석하지 않는다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  let interpreted = 0;
  const { w, alerts, advance } = watcher(ctx, net, { interpret: async () => (interpreted++, { code: 0, text: 'x' }) });
  const sent = { get length() { return alerts().length; } };
  net.news = [{ title: 'SK하이닉스 옛 기사', link: 'https://n/0' }];
  await w.tick(); // 기준선
  net.news = [
    { title: 'SK하이닉스 HBM4 공급', link: 'https://n/1' },
    { title: '삼성전자 파운드리 수주', link: 'https://n/2' },
    { title: 'SK하이닉스 3시간 전 기사', link: 'https://n/3', pubDate: 'Wed, 30 Sep 2026 05:00:00 +0900' },
    ...net.news,
  ];
  advance(180e3);
  await w.tick();
  assert.equal(sent.length, 1, '관심 종목(삼성전자) 뉴스는 기본 설정에서 보내지 않는다');
  assert.match(alerts()[0].title, /^📰 \[보유 100%\] SK하이닉스 — 뉴스 1건$/);
  assert.equal(alerts()[0].silent, true);
  net.news = [{ title: 'SK하이닉스 또 기사', link: 'https://n/4' }, ...net.news];
  advance(180e3);
  await w.tick();
  assert.equal(sent.length, 1, '20분 안에는 다시 보내지 않는다');
  net.news = [{ title: 'SK하이닉스 세 번째', link: 'https://n/5' }, ...net.news];
  advance(20 * 60e3);
  await w.tick();
  assert.equal(sent.length, 2);
  assert.match(alerts()[1].text, /1건은 묶어서 건너뜀/);
  advance(120e3);
  await w.tick();
  await w.idle();
  assert.equal(interpreted, 0, '뉴스는 모델에 넘기지 않는다 (언론사 약관)');

  updateWatchSettings({ news: 'off' }, ctx.settingsFile);
  const before = net.calls.filter((u) => u.includes('news.test')).length;
  advance(20 * 60e3);
  await w.tick();
  assert.equal(net.calls.filter((u) => u.includes('news.test')).length, before, 'off 면 가져오지도 않는다');
});

test('미국 — getcurrent 에서 대상 CIK 의 공시를 한 번만(역할별 중복 제거) 알린다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const { w, sent, advance } = watcher(ctx, net);
  await w.tick();
  net.edgar = atomEntry('0001045810-26-9', '8-K', 'NVIDIA CORP', '0001045810') + atomEntry('0001045810-26-9', '8-K', 'NVIDIA CORP', '0001045810', 'Subject') + atomEntry('0009-26-1', '8-K', 'Other', '0000000099');
  advance(60e3);
  await w.tick();
  assert.equal(sent.length, 1);
  assert.match(sent[0].title, /\[관심\] 엔비디아 — 8-K — NVIDIA CORP/);
});

test('맥이 잠들면(박동 타이머가 늦게 옴) 공백으로 기록·알리고 종목별 점검을 바로 돈다 — 한 바퀴가 느린 것(네트워크)은 공백이 아니다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  let sweeps = 0;
  const { w, sent, advance, sleep } = watcher(ctx, net, { dart: { filings: async () => (sweeps++, { filings: [] }) } });
  w.beat();
  await w.tick();
  const first = sweeps;
  advance(3 * 60e3); // 깨어 있었지만 한 바퀴가 3분 걸렸다 — 타이머는 제때 왔다
  await w.tick();
  assert.equal(readRecords(ctx.varDir, '2026-09-30').filter((r) => r.type === 'gap').length, 0);
  assert.equal(sweeps, first, '종목별 점검 주기(10분) 전');
  sleep(3 * 60e3);
  await w.tick();
  assert.equal(sweeps, first * 2, '공백 뒤에는 주기를 기다리지 않고 종목별 점검');
  assert.equal(readRecords(ctx.varDir, '2026-09-30').find((r) => r.type === 'gap').minutes, 3);
  assert.ok(!sent.some((m) => m.title.includes('감시 공백')), '10분 미만은 알리지 않는다');
  sleep(45 * 60e3);
  await w.tick();
  assert.ok(sent.some((m) => m.title.includes('감시 공백') && m.silent));
  assert.equal(watchStatus(ctx.varDir, { settings: {} }).today.gaps.length, 2);
});

/** run() 을 한 바퀴만 — 첫 틱 뒤 멈춘다 */
async function runOnce(w) {
  const ac = new AbortController();
  const p = w.run({ signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await p;
}

test('종료·로그아웃(SIGTERM)으로 멈춘 동안은 다음에 켤 때(run) 공백이다. 사용자가 끈 것(requestStop)은 공백이 아니다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const gaps = () => readRecords(ctx.varDir, '2026-09-30').filter((r) => r.type === 'gap').length;
  const a = watcher(ctx, net);
  await runOnce(a.w); // 표시 없이 멈춤 — 맥 종료
  assert.ok(!readWatchState(ctx.varDir).stopped_at);
  const b = watcher(ctx, net);
  b.clock.t = T0 + 3600e3;
  await runOnce(b.w);
  assert.equal(gaps(), 1, '꺼져 있던 한 시간이 공백으로 남는다 (run 의 첫 저장이 지우지 않는다)');

  // 돌고 있는 감시에 끄기 요청 → 신호를 받은 순간 표시가 저장된다 (한 바퀴가 길어 강제 종료돼도)
  requestStop(ctx.varDir);
  b.w.onSignal();
  assert.ok(readWatchState(ctx.varDir).stopped_at);
  const c = watcher(ctx, net);
  c.clock.t = T0 + 5 * 3600e3;
  await runOnce(c.w);
  assert.equal(gaps(), 1, '사용자가 끈 동안은 공백이 아니다');
});

test('손으로 한 바퀴(sss watch once, startupGap=false)는 지난 실행과의 간격을 공백으로 치지 않는다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  await runOnce(watcher(ctx, net).w);
  const once = watcher(ctx, net, { startupGap: false });
  once.clock.t = T0 + 3 * 86400e3;
  await once.w.tick();
  assert.equal(readRecords(ctx.varDir, '2026-10-03').filter((r) => r.type === 'gap').length, 0);
  assert.ok(!once.sent.some((m) => m.title.includes('감시 공백')));
});

test('끄기 표시만 남고 강제 종료됐어도(신호 처리 전) 다음에 켤 때 사용자가 끈 것으로 본다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const a = watcher(ctx, net);
  await runOnce(a.w);
  requestStop(ctx.varDir); // SIGKILL — onSignal 이 못 돌았다
  const b = watcher(ctx, net);
  b.clock.t = T0 + 2 * 3600e3;
  await runOnce(b.w);
  assert.equal(readRecords(ctx.varDir, '2026-09-30').filter((r) => r.type === 'gap').length, 0);
  assert.ok(!existsSync(join(ctx.varDir, 'watch', 'stop-requested')));
});

// ── 코드 리뷰 회귀 ───────────────────────────────────────────────
test('리뷰 H1 — 뉴스 제목은 기록에도, 조회 도구에도 남지 않는다 (텔레그램으로만 간다)', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const { w, alerts, advance } = watcher(ctx, net);
  await w.tick();
  net.news = [{ title: 'SK하이닉스 단독 기사', link: 'https://n/9' }];
  advance(180e3);
  await w.tick();
  assert.match(alerts()[0].text, /SK하이닉스 단독 기사/);
  assert.ok(!readFileSync(join(ctx.varDir, 'watch', 'alerts-2026-09-30.jsonl'), 'utf8').includes('단독 기사'));
  const q = queryAlerts(ctx.varDir, { date: '2026-09-30', kind: 'news' });
  assert.equal(q.alerts[0].url, 'https://n/9');
  assert.equal(q.alerts[0].title, undefined);
});

test('리뷰 H2 — 종목을 새로 넣어도 그 종목의 어제·오늘 공시가 쏟아지지 않는다 (종목별 기준선), 그 뒤 새 공시는 간다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const filings = { '000660': [], '035420': [] };
  const row = (n, title) => ({ rcept_no: `20260929${String(n).padStart(6, '0')}`, date: '2026-09-29', title, url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260929${String(n).padStart(6, '0')}` });
  let interpreted = 0;
  const { w, alerts, advance } = watcher(ctx, net, {
    dart: { filings: async (code) => ({ filings: filings[code] ?? [] }) },
    interpret: async () => (interpreted++, { code: 0, text: 'x' }),
  });
  await w.tick();
  writeFileSync(join(ctx.root, 'portfolio.yaml'), `watchlist:\n  - { market: KR, code: "035420", name: NAVER }\nholdings:\n  - { market: KR, code: "000660", name: SK하이닉스, quantity: 10, avg_price: 100000 }\n`);
  filings['035420'] = [row(1, '단일판매ㆍ공급계약체결'), row(2, '투자판단관련주요경영사항'), row(3, '자기주식취득결정')];
  advance(600e3);
  await w.tick();
  advance(60e3);
  await w.tick();
  await w.idle();
  assert.equal(alerts().length, 0, '새 종목의 지난 공시는 기록만');
  assert.equal(interpreted, 0, '해석 한도도 쓰지 않는다');
  assert.equal(readRecords(ctx.varDir, '2026-09-30').filter((r) => r.code === '035420' && r.reason === 'baseline').length, 3);
  filings['035420'].unshift(row(4, '유상증자결정'));
  advance(600e3);
  await w.tick();
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0].title, /NAVER — 유상증자결정/);
});

test('리뷰 H3 — 종목 하나가 DART 에서 안 찾아져도(우선주·ETF) 나머지 종목의 점검은 계속된다', async () => {
  const ctx = setup({ decision: false });
  writeFileSync(join(ctx.root, 'portfolio.yaml'), `watchlist:\n  - { market: KR, code: "005935", name: 삼성전자우 }\nholdings:\n  - { market: KR, code: "000660", name: SK하이닉스, quantity: 10, avg_price: 100000 }\n`);
  const net = fakeNet();
  const filings = { '000660': [] };
  const { w, alerts, advance } = watcher(ctx, net, {
    dart: {
      filings: async (code) => {
        if (!filings[code]) throw new Error(`상장사 목록에 없는 종목코드: ${code}`);
        return { filings: filings[code] };
      },
    },
  });
  await w.tick();
  assert.match(w.state.sources.dart_sweep.target_errors[0], /005935/);
  assert.equal(w.state.sources.dart_sweep.last_error, null);
  filings['000660'] = [{ rcept_no: '20260930000077', date: '2026-09-30', title: '잠정실적', url: 'https://dart.fss.or.kr/x' }];
  advance(600e3);
  await w.tick();
  assert.equal(alerts().length, 1);
});

test('리뷰 M1·M2 — 한 폴링에 같은 공시가 두 번 와도 한 번만 보내고, 보낸 즉시 상태에 남는다 (곧바로 죽어도 다시 안 보낸다)', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const { w, alerts, advance } = watcher(ctx, net);
  await w.tick();
  const dup = dartRow(3, '000660', '잠정실적');
  net.dart = [dup, { ...dup }];
  advance(20e3);
  await w.tick();
  assert.equal(alerts().length, 1);
  assert.equal(w.mem.queue.length, 0, '해석이 없으면 줄도 없다');
  assert.ok(readWatchState(ctx.varDir).alerted['dart:20260930000003'], '30초 저장 주기를 기다리지 않는다');
  const again = watcher(ctx, net);
  again.clock.t = T0 + 30e3;
  await again.w.tick();
  await again.w.tick();
  assert.equal(again.alerts().length, 0);
});

test('리뷰 M5 — 첫 뉴스 폴링이 전부 실패하면 기준선을 잡지 않는다 — 다음 성공이 기준선이다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  let down = true;
  const fetch = async (url) => (down && url.includes('news.test') ? new Response('', { status: 503 }) : net.fetch(url));
  const { w, alerts, advance } = watcher(ctx, net, { fetch });
  await w.tick();
  assert.match(w.state.sources.news.last_error, /503/);
  down = false;
  net.news = [{ title: 'SK하이닉스 두 시간 전 기사', link: 'https://n/1', pubDate: 'Wed, 30 Sep 2026 08:00:00 +0900' }];
  advance(60e3);
  await w.tick();
  assert.equal(alerts().length, 0, '처음 성공한 폴링은 기준선');
  net.news.unshift({ title: 'SK하이닉스 새 기사', link: 'https://n/2' });
  advance(180e3);
  await w.tick();
  assert.equal(alerts().length, 1);
});

test('리뷰 M6 — 원문을 기다리는 한국 공시가 다른 공시의 해석을 막지 않는다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const batches = [];
  const { w, advance } = watcher(ctx, net, {
    dart: { filings: async () => ({ filings: [] }), documentReady: async () => false },
    interpret: async ({ items }) => (batches.push(items.map((i) => i.source)), { code: 0, text: '■', model: 'm' }),
  });
  await w.tick();
  net.dart = Array.from({ length: 5 }, (_, i) => dartRow(10 + i, '000660', `공시 ${i}`));
  advance(20e3);
  await w.tick();
  await w.idle();
  net.edgar = atomEntry('0001045810-26-7', '8-K', 'NVIDIA CORP', '0001045810');
  advance(60e3);
  await w.tick();
  await w.idle();
  advance(60e3);
  await w.tick();
  await w.idle();
  assert.deepEqual(batches, [['SEC']]);
  assert.equal(w.mem.queue.length, 5, '한국 공시는 원문을 기다린다');
});

test('리뷰 Low — 해석 한도 0 이면 매일 "한도 다 씀" 안내를 보내지 않는다 · 해석의 낯선 링크는 지운다', async () => {
  const ctx = setup({ decision: false });
  updateWatchSettings({ llm_daily_cap: 0 }, ctx.settingsFile);
  const net = fakeNet();
  const { w, sent, advance } = watcher(ctx, net, { interpret: async () => ({ code: 0, text: 'x' }) });
  await w.tick();
  net.dart = [dartRow(3, '000660', '잠정실적')];
  advance(20e3);
  await w.tick();
  advance(60e3);
  await w.tick();
  assert.ok(!sent.some((m) => /한도/.test(m.text)));
  assert.equal(scrubLinks('원문 https://dart.fss.or.kr/dsaf001/main.do?rcpNo=1 · 자세히 https://evil.example/x · https://www.sec.gov/a'),
    '원문 https://dart.fss.or.kr/dsaf001/main.do?rcpNo=1 · 자세히 [링크 제거] · https://www.sec.gov/a');
  assert.equal(scrubLinks('https://dart.fss.or.kr.evil.io/x'), '[링크 제거]');
  assert.equal(scrubLinks('로그인 evil.com/login · t.me/x · @helpbot 문의'), '로그인 [링크 제거] · [링크 제거] · ＠helpbot 문의');
  assert.equal(scrubLinks('지분율 76.39% · 7,027,757주'), '지분율 76.39% · 7,027,757주', '숫자는 건드리지 않는다');
});

test('재검증 N4 — 한 바퀴 도중에 잠금을 잃으면 그 바퀴의 나머지 알림도 보내지 않는다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  let beats = 0;
  const filings = { '005930': [] };
  const { w, alerts, advance } = watcher(ctx, net, {
    heartbeat: () => ++beats < 3, // 1: 첫 바퀴 저장 · 2: 알림 직전 확인 · 3: 알림 뒤 저장에서 잃음
    dart: { filings: async (code) => ({ filings: filings[code] ?? [] }) },
  });
  await w.tick(); // 기준선 · 저장 1회(잠금 유지)
  net.dart = [dartRow(3, '000660', '잠정실적')];
  filings['005930'] = [{ rcept_no: '20260930000099', date: '2026-09-30', title: '배당결정', url: 'https://dart.fss.or.kr/y' }];
  advance(600e3);
  await w.tick(); // 빠른 길 알림 → 저장하며 잠금 잃음 → 같은 바퀴의 종목별 점검은 보내기 직전 확인에서 멈춘다
  assert.equal(w.mem.lockLost, true);
  assert.equal(alerts().length, 1);
});

test('재검증 N5·N7 — 시장의 마지막 종목을 빼도 기준선 표시가 지워진다 · 실패한 소스는 1분부터 2배씩 늦춰 다시', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const { w, clock, advance } = watcher(ctx, net);
  await w.tick();
  assert.ok(w.state.baseline_targets.dart_sweep['KR:000660']);
  writeFileSync(join(ctx.root, 'portfolio.yaml'), 'watchlist:\n  - { market: US, code: NVDA, name: 엔비디아 }\n');
  advance(20e3);
  await w.tick();
  assert.deepEqual(Object.keys(w.state.baseline_targets.dart_sweep), []);

  const bad = watcher(setup({ decision: false }), net, { dart: { filings: async () => { throw new Error('DART 500'); } } });
  await bad.w.tick();
  assert.equal(bad.w.mem.nextAt.dart_sweep - bad.clock.t, 60e3);
  bad.advance(60e3);
  await bad.w.tick();
  assert.equal(bad.w.mem.nextAt.dart_sweep - bad.clock.t, 120e3);
  void clock;
});

test('리뷰 Low — 잠금을 잃으면(다른 감시가 넘겨받음) 상태를 쓰지 않고 멈춘다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const { w } = watcher(ctx, net, { heartbeat: () => false });
  await w.run({ signal: new AbortController().signal }); // 첫 저장에서 잠금을 잃고 스스로 끝난다
  assert.equal(w.mem.lockLost, true);
  assert.ok(!existsSync(join(ctx.varDir, 'watch', 'state.json')), '넘겨받은 감시의 상태를 덮어쓰지 않는다');
});

test('리뷰 Low — 재시도는 macOS 대체 알림을 다시 띄우지 않는다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const calls = [];
  const { w, advance } = watcher(ctx, net, { notify: async (m) => (calls.push(m.fallback), { via: null, error: 'down' }) });
  await w.tick();
  net.dart = [dartRow(3, '000660', '잠정실적')];
  advance(20e3);
  await w.tick();
  advance(40e3);
  await w.tick();
  assert.deepEqual(calls, [undefined, false]);
});

test('dry-run 은 아무것도 쓰지 않고 보내지도 않는다', async () => {
  const ctx = setup();
  const net = fakeNet();
  net.dart = [dartRow(1, '000660', '잠정실적')];
  const logs = [];
  const { w, sent } = watcher(ctx, net, { dryRun: true, log: (m) => logs.push(m) });
  await w.tick();
  assert.equal(sent.length, 0);
  assert.ok(!existsSync(join(ctx.varDir, 'watch')) || !readdirSync(join(ctx.varDir, 'watch')).length);
  assert.ok(logs.some((l) => /\[dry-run\] 알림 none \(baseline\) · SK하이닉스/.test(l)));
});

test('포트폴리오가 깨져도 감시는 죽지 않고 직전 대상으로 계속 본다', async () => {
  const ctx = setup({ decision: false });
  const net = fakeNet();
  const logs = [];
  const { w, advance } = watcher(ctx, net, { log: (m) => logs.push(m) });
  await w.tick();
  writeFileSync(join(ctx.root, 'portfolio.yaml'), 'holdings: [ {');
  advance(20e3);
  await w.tick();
  assert.equal(w.state.targets.KR, 2);
  assert.ok(logs.some((l) => l.includes('대상 읽기 실패')));
});

test('주기 — DART 는 평일 07~20시 20초·그 밖 5분, 뉴스는 06시부터 3분', () => {
  assert.equal(cadence('dart', T0), 20e3);
  assert.equal(cadence('dart', Date.parse('2026-10-03T01:00:00Z')), 300e3, '토요일');
  assert.equal(cadence('dart', Date.parse('2026-09-30T12:00:00Z')), 300e3, '21시');
  assert.equal(cadence('news', Date.parse('2026-09-29T18:00:00Z')), 900e3, '03시');
  assert.equal(cadence('edgar', T0), 60e3);
});

test('설정 — 기본값, 틀린 값은 거부, 파일이 손상돼도 기본값', () => {
  const file = join(tmp('sss-ws-'), 'settings.json');
  assert.deepEqual(watchSettings({}), WATCH_DEFAULTS);
  assert.deepEqual(updateWatchSettings({ news: 'all', llm_daily_cap: 3, bogus: 1 }, file), { ...WATCH_DEFAULTS, news: 'all', llm_daily_cap: 3 });
  assert.throws(() => updateWatchSettings({ news: 'loud' }, file), /news/);
  assert.throws(() => updateWatchSettings({ llm_daily_cap: 99 }, file), /0~50/);
  assert.deepEqual(watchSettings({ watch: { news: 'x', llm_daily_cap: -1, interpret: 'yes' } }), WATCH_DEFAULTS);
});

test('감시는 하나만 — 쥐고 있으면 두 번째는 못 뜨고, 갱신이 3분 넘게 멈춘 잠금은 넘겨받는다', () => {
  const varDir = tmp('sss-wl-');
  const release = acquireWatchLock(varDir);
  assert.throws(() => acquireWatchLock(varDir), (e) => e.code === 'SSS_WATCH_RUNNING' && /상시 감시가 이미 실행 중/.test(e.message));
  const [file] = readdirSync(join(varDir, 'watch')).filter((f) => f.endsWith('.lock'));
  const path = join(varDir, 'watch', file);
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...lock, at: Date.now() - 4 * 60e3 }));
  release.refresh();
  assert.ok(Date.now() - JSON.parse(readFileSync(path, 'utf8')).at < 5e3, '쥔 쪽이 갱신한다');
  writeFileSync(path, JSON.stringify({ ...lock, at: Date.now() - 4 * 60e3 }));
  const r2 = acquireWatchLock(varDir);
  r2();
  release();
});

test('브리핑 요약 — 감시를 켠 적 없으면 null, 켰으면 알림 수와 공백. 대체 브리핑에 실린다', async () => {
  const ctx = setup({ decision: false });
  assert.equal(watchDigest(ctx.varDir, '2026-09-29', '2026-09-30'), null);
  const net = fakeNet();
  const { w, advance } = watcher(ctx, net);
  await w.run({ signal: AbortSignal.abort() });
  await w.tick();
  net.dart = [dartRow(3, '000660', '잠정실적')];
  advance(20e3);
  await w.tick();
  const d = watchDigest(ctx.varDir, '2026-09-29', '2026-09-30');
  assert.equal(d.alerts, 1);
  assert.equal(d.pushed, 1);
  const md = fallbackMarkdown({
    date: '2026-09-30', since: '2026-09-29', until: '2026-09-30', generated_at: 'x', universe: [], items: [], failures: [], open_decisions: [],
    pending_proposals: { count: 0 }, watch: { ...d, running: false, last_seen: '2026-09-30 10:00:20 KST', gaps: [{ from: 'a', to: 'b', minutes: 45 }] },
  }, 'r');
  assert.match(md, /장중 감시: 알림 1건 \(보냄 1\) · ⚠ 감시가 멈춰 있음/);
  assert.match(md, /감시 공백 a ~ b \(45분\)/);
});

// ── 텔레그램 ─────────────────────────────────────────────────────
function fakeBot({ updates = [] } = {}) {
  const bot = { sent: [], updates, offsets: [] };
  bot.fetch = async (url, init) => {
    const method = url.split('/').pop();
    const body = JSON.parse(init.body);
    if (method === 'getMe') return json({ ok: true, result: { username: 'sss_test_bot' } });
    if (method === 'getUpdates') {
      if (body.offset != null) bot.offsets.push(body.offset);
      return json({ ok: true, result: bot.updates });
    }
    if (method === 'sendMessage') {
      if (bot.failWith) return json({ ok: false, description: bot.failWith, parameters: { retry_after: 7 } }, 429);
      bot.sent.push(body);
      return json({ ok: true, result: {} });
    }
    return json({ ok: false, description: 'nope' }, 404);
  };
  return bot;
}

test('텔레그램 연결 — 코드를 보낸 1:1 대화만 묶는다 (먼저 말 건 사람·그룹·옛 메시지는 무시)', async () => {
  const file = join(tmp('sss-tg-'), 'settings.json');
  const bot = fakeBot();
  const tg = createTelegram({ token: '123:SECRET', fetch: bot.fetch });
  const now = Date.parse('2026-09-30T01:00:00Z');
  const s = await startLink({ tg, file, now });
  assert.match(s.code, /^\d{6}$/);
  assert.equal(s.link, `https://t.me/sss_test_bot?start=${s.code}`);
  const sec = now / 1000;
  bot.updates = [
    { update_id: 1, message: { date: sec + 5, text: 'hi', chat: { id: 666, type: 'private', username: 'stranger' } } },
    { update_id: 2, message: { date: sec + 6, text: s.code, chat: { id: -100, type: 'group' } } },
    { update_id: 3, message: { date: sec - 3600, text: s.code, chat: { id: 555, type: 'private' } } },
  ];
  await assert.rejects(confirmLink({ tg, file, now: now + 30e3 }), /아직 받지 못했다/);
  bot.updates.push({ update_id: 4, message: { date: sec + 20, text: `/start ${s.code}`, chat: { id: 42, type: 'private', first_name: '주환' } } });
  const r = await confirmLink({ tg, file, now: now + 30e3 });
  assert.deepEqual(r, { linked: true, chat: '주환' });
  assert.equal(readSettings(file).telegram.chat_id, 42);
  assert.ok(!readSettings(file).telegram.pending, '코드는 한 번 쓰면 사라진다');
  assert.deepEqual(bot.offsets, [-100, -100, 5], '확인할 때마다 가장 최근 100개를 보고, 찾으면 읽은 메시지를 치운다');
  assert.equal(bot.sent[0].chat_id, 42);
  assert.deepEqual(telegramStatus({ env: { TELEGRAM_BOT_TOKEN: 'x' }, settings: readSettings(file) }).chat, '주환');
  assert.deepEqual(unlink(file), { linked: false, removed: true });
});

test('텔레그램 연결 — 만료된 코드는 거부, 토큰이 없으면 발급 안내, 오류에 토큰이 새지 않는다', async () => {
  const file = join(tmp('sss-tg2-'), 'settings.json');
  const bot = fakeBot();
  const tg = createTelegram({ token: '123:SECRET', fetch: bot.fetch });
  await startLink({ tg, file, now: 0 });
  await assert.rejects(confirmLink({ tg, file, now: 11 * 60e3 }), /만료/);
  assert.throws(() => createTelegram({ token: '' }), /BotFather/);
  const leaky = createTelegram({ token: '123:SECRET', fetch: async (u) => { throw new Error(`connect ECONNREFUSED ${u}`); } });
  await assert.rejects(leaky.getMe(), (e) => !e.message.includes('SECRET') && e.message.includes('<token>'));
});

test('알림 보내기 — 연결돼 있으면 텔레그램(평문·미리보기 끔), 실패하면 오류와 재시도 간격, 연결 전이면 macOS', async () => {
  const file = join(tmp('sss-push-'), 'settings.json');
  writeFileSync(file, JSON.stringify({ telegram: { chat_id: 42 } }));
  const bot = fakeBot();
  const mac = [];
  const opts = { env: { TELEGRAM_BOT_TOKEN: 't' }, file, fetch: bot.fetch, mac: (t, m) => (mac.push(t), true) };
  assert.deepEqual(await push({ title: 'T', text: '<b>x</b>', silent: true }, opts), { via: 'telegram' });
  assert.equal(bot.sent[0].text, 'T\n<b>x</b>');
  assert.equal(bot.sent[0].parse_mode, undefined, '외부 제목이 서식으로 해석되지 않게');
  assert.equal(bot.sent[0].disable_notification, true);
  bot.failWith = 'Too Many Requests';
  const r = await push({ title: 'T', text: 'x' }, opts);
  assert.equal(r.via, null);
  assert.equal(r.retryAfter, 7);
  assert.deepEqual(await push({ title: 'T', text: 'x' }, { ...opts, env: {} }), { via: 'mac' });
});
