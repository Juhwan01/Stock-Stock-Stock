import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { readPortfolio, updateWatchlist, updateHoldings, summarize, universe } from '../lib/portfolio.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'sss-pf-'));
const ok = { user_confirmed: true };

test('파일이 없으면 빈 포트폴리오', () => {
  const p = readPortfolio(root());
  assert.deepEqual([p.watchlist, p.holdings], [[], []]);
});

test('워치리스트 — 추가·중복은 갱신·제거, 한국 코드는 따옴표 없이 저장돼도 문자열로 읽힌다', () => {
  const r = root();
  updateWatchlist(r, { add: [{ market: 'KR', code: '000660', name: 'SK하이닉스' }, { market: 'US', code: 'nvda', name: '엔비디아' }], ...ok });
  const again = updateWatchlist(r, { add: [{ market: 'US', code: 'NVDA', name: 'NVIDIA', note: 'HBM 고객' }], remove: [{ market: 'KR', code: '005930' }], ...ok });
  assert.deepEqual(again.not_found, ['KR:005930']);
  const p = readPortfolio(r);
  assert.equal(p.watchlist.length, 2, '같은 종목은 두 번 들어가지 않는다');
  assert.deepEqual(p.watchlist.map((w) => w.code), ['000660', 'NVDA']);
  assert.equal(p.watchlist[1].name, 'NVIDIA');
  assert.match(readFileSync(join(r, 'portfolio.yaml'), 'utf8'), /code: "000660"/, '앞자리 0 이 사라지지 않게 따옴표로 쓴다');
  updateWatchlist(r, { remove: [{ market: 'US', code: 'nvda' }], ...ok });
  assert.equal(readPortfolio(r).watchlist.length, 1);
});

test('종목코드 형식이 틀리면 거부한다 — 이름으로 대충 넣지 않게', () => {
  assert.throws(() => updateWatchlist(root(), { add: [{ market: 'KR', code: '하이닉스', name: 'SK하이닉스' }], ...ok }), /6자리/);
  assert.throws(() => updateWatchlist(root(), { add: [{ market: 'US', code: 'NV DA', name: 'x' }], ...ok }), /티커/);
});

test('사용자 확인 없이는 쓰지 않는다', () => {
  assert.throws(() => updateWatchlist(root(), { add: [{ market: 'KR', code: '000660', name: 'SK하이닉스' }] }), ZodError);
  assert.throws(() => updateHoldings(root(), { positions: [] }), ZodError);
});

test('체결 신고 — 평단은 코드가 계산하고, 매도는 평단을 바꾸지 않는다', () => {
  const r = root();
  updateHoldings(r, { positions: [{ market: 'KR', code: '000660', name: 'SK하이닉스', quantity: 10, avg_price: 200000 }], ...ok });
  updateHoldings(r, { trades: [{ market: 'KR', code: '000660', side: 'buy', quantity: 10, price: 230000 }], ...ok });
  let h = readPortfolio(r).holdings[0];
  assert.deepEqual([h.quantity, h.avg_price], [20, 215000]);
  updateHoldings(r, { trades: [{ market: 'KR', code: '000660', side: 'sell', quantity: 5, price: 250000 }], ...ok });
  h = readPortfolio(r).holdings[0];
  assert.deepEqual([h.quantity, h.avg_price], [15, 215000]);
  assert.throws(() => updateHoldings(r, { trades: [{ market: 'KR', code: '000660', side: 'sell', quantity: 16, price: 1 }], ...ok }), /많이 팔 수 없다/);
  assert.throws(() => updateHoldings(r, { trades: [{ market: 'KR', code: '005930', side: 'sell', quantity: 1, price: 1 }], ...ok }), /보유하지 않은/);
  assert.throws(() => updateHoldings(r, { trades: [{ market: 'KR', code: '005930', side: 'buy', quantity: 1, price: 1 }], ...ok }), /name 이 필요/);
  updateHoldings(r, { trades: [{ market: 'KR', code: '000660', side: 'sell', quantity: 15, price: 250000 }], ...ok });
  assert.deepEqual(readPortfolio(r).holdings, [], '전량 매도면 보유에서 빠진다');
});

test('수량 0 으로 적으면 보유에서 뺀다', () => {
  const r = root();
  updateHoldings(r, { positions: [{ market: 'US', code: 'NVDA', name: '엔비디아', quantity: 3, avg_price: 120 }], ...ok });
  updateHoldings(r, { positions: [{ market: 'US', code: 'NVDA', name: '엔비디아', quantity: 0, avg_price: 0 }], ...ok });
  assert.deepEqual(readPortfolio(r).holdings, []);
});

test('비중 — 환율이 없으면 추정 환율로 합산하지 않고 통화별로 계산한다', () => {
  const r = root();
  updateHoldings(r, {
    positions: [
      { market: 'KR', code: '000660', name: 'SK하이닉스', quantity: 10, avg_price: 200000 }, // 200만
      { market: 'KR', code: '005930', name: '삼성전자', quantity: 10, avg_price: 60000 }, // 60만
      { market: 'US', code: 'NVDA', name: '엔비디아', quantity: 10, avg_price: 100 }, // $1,000
    ],
    cash: { KRW: 1400000 },
    ...ok,
  });
  let s = summarize(readPortfolio(r));
  assert.match(s.weight_basis, /통화별/);
  assert.equal(s.holdings.find((h) => h.code === '000660').weight, 0.5, '원화 400만 중 200만');
  assert.equal(s.holdings.find((h) => h.code === 'NVDA').weight, 1);

  updateHoldings(r, { fx_usdkrw: 1400, ...ok });
  s = summarize(readPortfolio(r));
  assert.match(s.weight_basis, /원화 합산 \(USDKRW 1400/);
  assert.equal(s.totals.KRW, 5400000);
  assert.deepEqual(s.holdings.map((h) => h.code), ['000660', 'NVDA', '005930'], '비중 큰 순');
  assert.equal(s.holdings[1].weight, 0.2593);
});

test('브리핑 대상 — 보유(비중 큰 순) 다음 관심 종목, 보유 종목은 중복되지 않는다', () => {
  const r = root();
  updateWatchlist(r, { add: [{ market: 'US', code: 'NVDA', name: '엔비디아' }, { market: 'KR', code: '000660', name: 'SK하이닉스' }], ...ok });
  updateHoldings(r, { positions: [{ market: 'KR', code: '000660', name: 'SK하이닉스', quantity: 1, avg_price: 1 }], ...ok });
  assert.deepEqual(universe(readPortfolio(r)).map((u) => `${u.role}:${u.code}`), ['holding:000660', 'watch:NVDA']);
});

test('손으로 고친 파일의 형식 오류는 어디가 틀렸는지 알려준다', () => {
  const r = root();
  writeFileSync(join(r, 'portfolio.yaml'), 'holdings:\n  - market: KR\n    code: 000660\n    name: SK하이닉스\n    quantity: -1\n    avg_price: 1\n');
  assert.throws(() => readPortfolio(r), /holdings\.0\.quantity/);
  writeFileSync(join(r, 'portfolio.yaml'), 'holdings:\n  - market: KR\n    code: 000660\n    name: SK하이닉스\n    quantity: 1\n    avg_price: 1\n');
  assert.throws(() => readPortfolio(r), /6자리/, '따옴표 없는 000660 은 숫자 660 으로 읽힌다 — 조용히 틀린 종목이 되지 않게');
});

test('portfolio.yaml 을 위키 밖 파일 링크로 바꿔도 그 파일을 읽거나 고치지 않는다', () => {
  const r = root();
  const outside = join(mkdtempSync(join(tmpdir(), 'sss-outside-')), 'secret.yaml');
  writeFileSync(outside, 'watchlist: []\n');
  symlinkSync(outside, join(r, 'portfolio.yaml'));
  assert.throws(() => readPortfolio(r), /링크 금지/);
  assert.throws(() => updateWatchlist(r, { add: [{ market: 'KR', code: '000660', name: 'x' }], ...ok }), /링크 금지/);
  assert.equal(readFileSync(outside, 'utf8'), 'watchlist: []\n');
});

test('소수점 주식 — 부동소수 오차로 팔 수 있는 수량을 못 팔거나 0 에 가까운 찌꺼기가 남지 않는다', () => {
  const r = root();
  const t = (side, quantity) => updateHoldings(r, { trades: [{ market: 'US', code: 'AAPL', name: '애플', side, quantity, price: 200 }], ...ok });
  t('buy', 0.3);
  t('sell', 0.1);
  t('sell', 0.2);
  assert.deepEqual(readPortfolio(r).holdings, []);
  t('buy', 0.1);
  t('buy', 0.2);
  assert.equal(readPortfolio(r).holdings[0].quantity, 0.3);
  t('sell', 0.3);
  assert.deepEqual(readPortfolio(r).holdings, [], '5.55e-17주가 남아 보유로 남지 않는다');
  updateHoldings(r, { positions: [{ market: 'US', code: 'AAPL', name: '애플', quantity: 1e-9, avg_price: 200 }], ...ok });
  assert.deepEqual(readPortfolio(r).holdings, [], '반올림해 0 이 되는 수량은 제거로 본다 — 0 을 저장해 파일이 깨지지 않게');
  assert.throws(() => t('buy', 1e-9), /너무 작다/);
  assert.doesNotThrow(() => readPortfolio(r));
});

test('환율이 없으면 통화별 비중끼리 섞어 정렬하지 않는다 — 원화 자산 먼저', () => {
  const r = root();
  updateHoldings(r, {
    positions: [
      { market: 'US', code: 'AAPL', name: '애플', quantity: 0.05, avg_price: 200 }, // $10 — 달러 안에선 100%
      { market: 'KR', code: '005930', name: '삼성전자', quantity: 1000, avg_price: 70000 }, // 7천만원
    ],
    cash: { KRW: 2000000 },
    ...ok,
  });
  assert.deepEqual(universe(readPortfolio(r)).map((u) => u.code), ['005930', 'AAPL']);
});
