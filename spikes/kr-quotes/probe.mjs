/**
 * Phase 0 스파이크: 무계좌 한국 시세 소스 실측
 *
 * 리서치 두 건의 권고가 충돌해 직접 검증한다.
 *   - kr-official-data: 네이버 비공식 엔드포인트 비권장 (약관·안정성)
 *   - global-kr-coverage: 네이버 1위 추천 (무료·무키·실시간)
 *
 * 확인할 것: 실제로 응답하는가 / 지연은 얼마인가 / 히스토리 깊이 / 안정성
 */
const KST = (d) => new Date(d).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
const now = Date.now();
const won = (n) => Number(n).toLocaleString('ko-KR') + '원';

console.log(`실측 시각: ${KST(now)} KST\n`);

async function get(url, label) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    const text = await res.text();
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, text, label };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: e.message, label };
  }
}

// ── 1. 네이버 실시간 시세 ──────────────────────────────────────────
console.log('【1】 네이버 금융 실시간 시세');
const nv = await get('https://m.stock.naver.com/api/stock/005930/basic', 'naver-basic');
if (nv.ok) {
  const d = JSON.parse(nv.text);
  const ts = d.localTradedAt ?? d.tradeStopYn;
  console.log(`  ✅ ${d.stockName} ${won(d.closePrice.replace(/,/g, ''))}  (${d.compareToPreviousClosePrice} / ${d.fluctuationsRatio}%)`);
  console.log(`     체결시각: ${ts}`);
  if (d.localTradedAt) {
    const lagMin = (now - new Date(d.localTradedAt).getTime()) / 60000;
    console.log(`     ⏱  지연: ${lagMin.toFixed(1)}분`);
  }
  console.log(`     응답: ${nv.ms}ms`);
} else {
  console.log(`  ❌ ${nv.status} ${nv.error ?? ''}`);
}

// ── 2. 야후 파이낸스 지연 측정 ────────────────────────────────────
console.log('\n【2】 Yahoo Finance 지연 측정');
const yh = await get(
  'https://query1.finance.yahoo.com/v8/finance/chart/005930.KS?interval=1d&range=1d',
  'yahoo',
);
if (yh.ok) {
  const m = JSON.parse(yh.text).chart.result[0].meta;
  const lagMin = (now - m.regularMarketTime * 1000) / 60000;
  console.log(`  ✅ ${m.shortName ?? m.symbol} ${won(m.regularMarketPrice)}`);
  console.log(`     시세시각: ${KST(m.regularMarketTime * 1000)}`);
  console.log(`     ⏱  지연: ${lagMin.toFixed(1)}분   (장상태: ${m.marketState})`);
  console.log(`     응답: ${yh.ms}ms`);
} else {
  console.log(`  ❌ ${yh.status} — 야후는 IP 단위 429 차단이 공격적이다`);
}

// ── 3. 네이버 일별 히스토리 깊이 ──────────────────────────────────
console.log('\n【3】 네이버 일별 OHLCV 히스토리 깊이');
const hist = await get(
  'https://m.stock.naver.com/front-api/external/chart/domestic/info?symbol=005930&requestType=1&startTime=19990101&endTime=20260819&timeframe=day',
  'naver-hist',
);
if (hist.ok) {
  // 응답이 엄격한 JSON이 아니다 (헤더 행이 작은따옴표) — 관대한 파싱 필요
  const rows = JSON.parse(hist.text.replace(/'/g, '"'));
  const header = rows[0];
  const first = rows[1];
  const last = rows[rows.length - 1];
  console.log(`  ✅ ${rows.length - 1}개 일봉  (${first[0]} ~ ${last[0]})`);
  console.log(`     컬럼: ${header.join(', ')}`);
  console.log(`     최신: 종가 ${won(last[4])} / 거래량 ${Number(last[5]).toLocaleString('ko-KR')}`);
  console.log(`     응답: ${hist.ms}ms, ${(hist.text.length / 1024).toFixed(0)}KB`);
} else {
  console.log(`  ❌ ${hist.status} ${hist.error ?? ''}`);
}

// ── 4. 네이버 연속 호출 안정성 ────────────────────────────────────
console.log('\n【4】 네이버 무지연 연속 호출 10회 (레이트리밋 확인)');
const codes = ['005930', '000660', '035420', '035720', '005380', '051910', '006400', '207940', '068270', '105560'];
const results = await Promise.all(codes.map((c) => get(`https://m.stock.naver.com/api/stock/005930/basic`, c)));
const okCount = results.filter((r) => r.ok).length;
console.log(`  ${okCount === 10 ? '✅' : '⚠️'} ${okCount}/10 성공, 평균 ${(results.reduce((s, r) => s + r.ms, 0) / 10).toFixed(0)}ms`);
if (okCount < 10) console.log(`     실패 상태코드: ${[...new Set(results.filter((r) => !r.ok).map((r) => r.status))].join(', ')}`);

// ── 5. KOSPI 지수 ─────────────────────────────────────────────────
console.log('\n【5】 KOSPI 지수 (네이버)');
const idx = await get('https://m.stock.naver.com/api/index/KOSPI/basic', 'kospi');
if (idx.ok) {
  const d = JSON.parse(idx.text);
  console.log(`  ✅ ${d.stockName ?? 'KOSPI'} ${d.closePrice}  (${d.fluctuationsRatio}%)`);
} else {
  console.log(`  ❌ ${idx.status}`);
}

console.log('\n' + '─'.repeat(58));
console.log('판정');
console.log('─'.repeat(58));
console.log(`  네이버 접근성   : ${nv.ok ? '✅ 무키로 즉시 동작' : '❌'}`);
console.log(`  야후 접근성     : ${yh.ok ? '✅ 무키로 즉시 동작' : '⚠️ 차단됨 (429 가능성)'}`);
console.log(`  네이버 안정성   : ${okCount}/10`);
