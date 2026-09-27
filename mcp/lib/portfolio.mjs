/**
 * 포트폴리오 — 워치리스트 + 보유 원장 (PLAN.md M2, 정석 점검 §8 공백 1)
 *
 *  - 정본은 wiki/portfolio.yaml 하나. 개인 포지션이라 코드 레포가 아니라 위키(별도 private git)에 둔다
 *  - 증권사 연결(M4) 전까지는 사용자 자가 신고. 쓰기는 도구로만 — 스키마 검사 + 대화형 승인 (bin/sss WRITE_TOOLS)
 *  - 체결 신고(trades)는 평단을 코드가 계산한다 — 숫자는 LLM 이 아니라 코드가 다룬다 (§8 공백 2)
 *  - 브리핑·알림이 "노출 큰 순서"로 정렬하는 기준. 비중은 원가 기준이다 — 시가 평가는 증권사 연결 후
 */
import { z } from 'zod';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { kstDate, readRegular, writeAtomic } from './store.mjs';

export const FILE = 'portfolio.yaml';
export const CURRENCY = { KR: 'KRW', US: 'USD' };

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const market = z.enum(['KR', 'US']).describe('KR 한국 · US 미국');
const code = z.string().trim().min(1).describe('한국 6자리 종목코드(예: 000660) 또는 미국 티커(예: NVDA)');
const name = z.string().trim().min(1).max(60);

/** 시장별 종목코드 정규화·검사. 미국 티커는 대문자로 */
export function normCode(mkt, raw) {
  const c = mkt === 'US' ? String(raw).trim().toUpperCase() : String(raw).trim();
  if (mkt === 'KR' && !/^\d{6}$/.test(c)) throw new Error(`한국 종목코드는 6자리 숫자: ${raw} — 모르면 find_company`);
  if (mkt === 'US' && !/^[A-Z][A-Z0-9.-]{0,9}$/.test(c)) throw new Error(`미국 티커 형식이 아님: ${raw}`);
  return c;
}
const keyOf = (x) => `${x.market}:${x.code}`;

// ── 파일 스키마 — 손으로 고친 파일도 읽히도록 관대하게, 틀리면 어디가 틀렸는지 알려준다 ──
const watchEntry = z.object({ market, code: z.coerce.string(), name, note: z.string().optional(), added: day.optional() });
const holding = z.object({
  market, code: z.coerce.string(), name,
  quantity: z.number().positive(),
  avg_price: z.number().nonnegative(),
  updated: day.optional(),
});
const fileSchema = z.object({
  watchlist: z.array(watchEntry).default([]),
  holdings: z.array(holding).default([]),
  cash: z.object({ KRW: z.number().nonnegative().optional(), USD: z.number().nonnegative().optional() }).default({}),
  fx: z.object({ USDKRW: z.number().positive(), as_of: day.optional() }).optional(),
  updated_at: z.string().optional(),
});

const empty = () => fileSchema.parse({});

export function readPortfolio(root) {
  const raw = readRegular(join(root, FILE));
  if (raw == null) return empty();
  let data;
  try {
    data = parse(raw) ?? {};
  } catch (e) {
    throw new Error(`${FILE} YAML 오류 — ${e.message.split('\n')[0]}`);
  }
  const r = fileSchema.safeParse(data);
  if (!r.success) throw new Error(`${FILE} 형식 오류 — ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  for (const x of [...r.data.watchlist, ...r.data.holdings]) x.code = normCode(x.market, x.code);
  return r.data;
}

function save(root, p) {
  p.updated_at = new Date().toISOString();
  const header = '# 워치리스트·보유 원장 — sss 도구(watchlist_update · holdings_update)로 고친다. 비중은 원가 기준(자가 신고)\n';
  writeAtomic(join(root, FILE), header + stringify(p));
}

// ── 도구 입력 ──────────────────────────────────────────────────
const confirmed = z.literal(true, { message: '사용자가 대화에서 명시적으로 확인한 뒤에만 true 로 호출한다' });
const ref = { market, code };

export const watchlistShape = {
  add: z.array(z.object({ ...ref, name, note: z.string().max(200).optional() })).default([]).describe('추가 — 이미 있으면 이름·메모만 고친다'),
  remove: z.array(z.object(ref)).default([]).describe('제거 — 보유 중인 종목은 워치리스트에서 빠져도 보유로 계속 추적된다'),
  user_confirmed: confirmed,
};

export const holdingsShape = {
  positions: z.array(z.object({
    ...ref, name,
    quantity: z.number().nonnegative().describe('보유 수량 — 0 이면 보유에서 뺀다'),
    avg_price: z.number().nonnegative().describe('평균 단가 (현지 통화)'),
  })).default([]).describe('수량·평단을 통째로 적는다 (증권사 앱의 값 그대로)'),
  trades: z.array(z.object({
    ...ref, name: name.optional().describe('처음 사는 종목이면 필수'),
    side: z.enum(['buy', 'sell']),
    quantity: z.number().positive(),
    price: z.number().positive().describe('체결 단가 (현지 통화)'),
  })).default([]).describe('체결 신고 — 평단은 서버가 계산한다. 현금은 자동으로 바뀌지 않는다'),
  cash: z.object({ KRW: z.number().nonnegative().optional(), USD: z.number().nonnegative().optional() }).optional().describe('예수금을 통째로 적는다'),
  fx_usdkrw: z.number().positive().optional().describe('원/달러 환율 — 한·미 비중을 합산할 때만 쓴다'),
  as_of: day.optional().describe('신고 기준일. 생략하면 오늘'),
  user_confirmed: confirmed,
};

export function updateWatchlist(root, input) {
  const u = z.object(watchlistShape).parse(input);
  const p = readPortfolio(root);
  const today = kstDate();
  const added = [];
  const removed = [];
  const notFound = [];
  for (const a of u.add) {
    const c = normCode(a.market, a.code);
    const hit = p.watchlist.find((w) => w.market === a.market && w.code === c);
    if (hit) Object.assign(hit, { name: a.name, ...(a.note != null && { note: a.note }) });
    else p.watchlist.push({ market: a.market, code: c, name: a.name, ...(a.note != null && { note: a.note }), added: today });
    added.push(`${a.market}:${c}`);
  }
  for (const r of u.remove) {
    const c = normCode(r.market, r.code);
    const i = p.watchlist.findIndex((w) => w.market === r.market && w.code === c);
    if (i < 0) notFound.push(`${r.market}:${c}`);
    else removed.push(keyOf(p.watchlist.splice(i, 1)[0]));
  }
  save(root, p);
  return { added, removed, not_found: notFound, watchlist: p.watchlist.length };
}

// 부동소수 누적 오차를 흘리지 않게 — 평단은 소수 넷째 자리, 수량은 소수 여덟째 자리(미국 소수점 주식)까지.
// 안 하면 0.3주 사고 0.1주 판 뒤 0.2주를 못 팔거나, 전량 매도 뒤 5.55e-17주가 남아 영영 보유로 남는다 (코드 리뷰 재현)
const round4 = (x) => Math.round(x * 1e4) / 1e4;
const roundQ = (x) => Math.round(x * 1e8) / 1e8;

export function updateHoldings(root, input) {
  const u = z.object(holdingsShape).parse(input);
  const p = readPortfolio(root);
  const asOf = u.as_of ?? kstDate();
  const find = (mkt, c) => p.holdings.find((h) => h.market === mkt && h.code === c);
  const changes = [];

  for (const x of u.positions) {
    const c = normCode(x.market, x.code);
    const h = find(x.market, c);
    if (roundQ(x.quantity) === 0) {
      if (h) p.holdings.splice(p.holdings.indexOf(h), 1);
      changes.push({ key: `${x.market}:${c}`, action: h ? '제거' : '없음(무시)' });
    } else if (h) {
      Object.assign(h, { name: x.name, quantity: roundQ(x.quantity), avg_price: x.avg_price, updated: asOf });
      changes.push({ key: keyOf(h), action: '수정', quantity: h.quantity, avg_price: h.avg_price });
    } else {
      p.holdings.push({ market: x.market, code: c, name: x.name, quantity: roundQ(x.quantity), avg_price: x.avg_price, updated: asOf });
      changes.push({ key: `${x.market}:${c}`, action: '추가', quantity: x.quantity, avg_price: x.avg_price });
    }
  }

  for (const t of u.trades) {
    const c = normCode(t.market, t.code);
    const h = find(t.market, c);
    if (t.side === 'buy') {
      if (h) {
        const q = roundQ(h.quantity + t.quantity);
        h.avg_price = round4((h.quantity * h.avg_price + t.quantity * t.price) / q);
        h.quantity = q;
        h.updated = asOf;
        changes.push({ key: keyOf(h), action: '매수', quantity: h.quantity, avg_price: h.avg_price });
      } else {
        if (!t.name) throw new Error(`처음 사는 종목은 name 이 필요하다: ${t.market}:${c}`);
        if (roundQ(t.quantity) === 0) throw new Error(`수량이 너무 작다 (소수 여덟째 자리까지): ${t.quantity}`);
        p.holdings.push({ market: t.market, code: c, name: t.name, quantity: roundQ(t.quantity), avg_price: t.price, updated: asOf });
        changes.push({ key: `${t.market}:${c}`, action: '신규 매수', quantity: t.quantity, avg_price: t.price });
      }
    } else {
      if (!h) throw new Error(`보유하지 않은 종목을 팔 수 없다: ${t.market}:${c} — 보유를 먼저 positions 로 적는다`);
      if (roundQ(t.quantity) > h.quantity) throw new Error(`보유 ${h.quantity}주보다 많이 팔 수 없다: ${t.market}:${c} ${t.quantity}주`);
      h.quantity = roundQ(h.quantity - t.quantity); // 매도는 평단을 바꾸지 않는다
      h.updated = asOf;
      if (h.quantity === 0) p.holdings.splice(p.holdings.indexOf(h), 1);
      changes.push({ key: `${t.market}:${c}`, action: h.quantity === 0 ? '전량 매도' : '매도', quantity: h.quantity });
    }
  }

  if (u.cash) p.cash = { ...p.cash, ...u.cash };
  if (u.fx_usdkrw) p.fx = { USDKRW: u.fx_usdkrw, as_of: asOf };
  save(root, p);
  return { changes, ...summarize(p) };
}

/**
 * 비중 계산 — 원가 + 예수금 기준. 달러 자산이 있는데 환율이 없으면 통화별로 따로 계산하고 그렇다고 밝힌다
 * (추정 환율로 합산하지 않는다)
 */
export function summarize(p) {
  const usd = p.holdings.some((h) => h.market === 'US') || (p.cash.USD ?? 0) > 0;
  const rate = p.fx?.USDKRW;
  const basis = !usd || rate ? 'KRW' : 'currency';
  const toBase = (amount, cur) => (basis === 'KRW' && cur === 'USD' ? amount * rate : amount);
  const bucket = (cur) => (basis === 'KRW' ? 'KRW' : cur);

  const totals = {};
  const add = (b, v) => (totals[b] = (totals[b] ?? 0) + v);
  const rows = p.holdings.map((h) => {
    const currency = CURRENCY[h.market];
    const cost = h.quantity * h.avg_price;
    add(bucket(currency), toBase(cost, currency));
    return { ...h, currency, cost };
  });
  for (const [cur, v] of Object.entries(p.cash)) if (v) add(bucket(cur), toBase(v, cur));

  for (const r of rows) {
    const t = totals[bucket(r.currency)];
    r.weight = t ? Math.round((toBase(r.cost, r.currency) / t) * 1e4) / 1e4 : null;
  }
  // 통화별 비중은 서로 비교할 수 없다 — 원화 자산 먼저, 그 안에서 비중 순 (한국 중심)
  const curRank = (r) => (basis === 'KRW' ? 0 : r.currency === 'KRW' ? 0 : 1);
  rows.sort((a, b) => curRank(a) - curRank(b) || (b.weight ?? 0) - (a.weight ?? 0));
  return {
    basis: '원가 기준 · 자가 신고 — 시가 평가가 아니다',
    weight_basis: basis === 'KRW' ? (usd ? `원화 합산 (USDKRW ${rate}, ${p.fx.as_of ?? '기준일 없음'})` : '원화') : '통화별 (USDKRW 환율 없음 — 원화 자산 먼저 정렬, holdings_update 의 fx_usdkrw 로 넣으면 합산)',
    totals,
    holdings: rows,
    watchlist: p.watchlist,
    cash: p.cash,
    updated_at: p.updated_at ?? null,
  };
}

/** 브리핑·감시 대상 — 보유(비중 큰 순) 다음 관심 종목. 보유 종목은 워치리스트에 없어도 포함된다 */
export function universe(p) {
  const s = summarize(p);
  const out = s.holdings.map((h) => ({ market: h.market, code: h.code, name: h.name, role: 'holding', weight: h.weight }));
  const held = new Set(out.map(keyOf));
  for (const w of p.watchlist) if (!held.has(keyOf(w))) out.push({ market: w.market, code: w.code, name: w.name, role: 'watch', weight: null });
  return out;
}
