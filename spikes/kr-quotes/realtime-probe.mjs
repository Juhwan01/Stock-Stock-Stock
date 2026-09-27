/**
 * 무계좌 실시간 소스 실측 — 폴백 체인 후보 찾기
 *
 * 네이버가 0.8분으로 확인됐지만, 비공식이라 언제든 깨질 수 있다.
 * "네이버가 죽으면 다음은 무엇인가"에 답하려면 대안들의 지연을 실제로 재봐야 한다.
 *
 * 주의: 공개적으로 접근 가능한 엔드포인트만 호출한다.
 *       인증·페이월·안티봇 우회는 하지 않는다.
 */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const KST = (t) => new Date(t).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
const now = () => Date.now();
const num = (v) => Number(String(v ?? '').replace(/[,\s]/g, ''));

const T0 = now();
console.log(`실측 시각: ${KST(T0)} KST   (한국 정규장 09:00~15:30)\n`);

const results = [];

async function probe(name, url, extract, headers = {}) {
  const t = now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', ...headers },
      signal: AbortSignal.timeout(12000),
    });
    const ms = now() - t;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    const out = await extract(body, res);
    const lag = out.asOf ? (now() - out.asOf) / 60000 : null;
    results.push({ name, ok: true, ms, price: out.price, lag, note: out.note });
    console.log(`  ✅ ${name.padEnd(24)} ${out.price ? num(out.price).toLocaleString('ko-KR').padStart(10) + '원' : '(가격 미추출)'.padStart(12)}` +
      `  ${lag === null ? '  시각없음' : '지연 ' + lag.toFixed(1) + '분'}  ${ms}ms${out.note ? '  · ' + out.note : ''}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ❌ ${name.padEnd(24)} ${e.message}`);
  }
}

console.log('【삼성전자 005930 — 소스별 현재가와 지연】\n');

// 1. 네이버 모바일 (기준선) — 시간외 거래 중이면 그쪽이 최신이다.
await probe('네이버 m.stock', 'https://m.stock.naver.com/api/stock/005930/basic', (b) => {
  const d = JSON.parse(b);
  const over = d.overMarketPriceInfo;
  const live = over?.overMarketStatus === 'OPEN' ? over : null;
  return {
    price: live?.overPrice ?? d.closePrice,
    asOf: new Date(live?.localTradedAt ?? d.localTradedAt).getTime(),
    note: live ? '시간외' : '정규장',
  };
});

// 2. 네이버 폴링 API — 정규장 종가와 시간외를 분리 제공한다.
//    localTradedAt 은 정규장 마감(15:30) 고정이고, 장 마감 후 실시간은 overMarketPriceInfo 에 있다.
await probe('네이버 polling', 'https://polling.finance.naver.com/api/realtime/domestic/stock/005930', (b) => {
  const s = JSON.parse(b)?.datas?.[0];
  const over = s?.overMarketPriceInfo;
  const live = over?.overMarketStatus === 'OPEN' ? over : null;
  return {
    price: live?.overPrice ?? s?.closePrice,
    asOf: new Date(live?.localTradedAt ?? s?.localTradedAt).getTime(),
    note: live ? `시간외(${live.tradingSessionType})` : '정규장 종가',
  };
});

// 3. 네이버 통합검색 시세
await probe('네이버 api.stock', 'https://api.stock.naver.com/stock/005930/basic', (b) => {
  const d = JSON.parse(b);
  return { price: d.closePrice, asOf: d.localTradedAt ? new Date(d.localTradedAt).getTime() : null };
});

// 4. 다음 금융 — date 는 날짜만 있고, 체결 시각은 tradeDate+tradeTime 에 따로 있다.
await probe('다음 금융', 'https://finance.daum.net/api/quotes/A005930?summary=false&changeStatistics=true', (b) => {
  const d = JSON.parse(b);
  const [, y, mo, dd] = d.tradeDate?.match(/(\d{4})(\d{2})(\d{2})/) ?? [];
  const [, hh, mi, ss] = d.tradeTime?.match(/(\d{2})(\d{2})(\d{2})/) ?? [];
  const asOf = y ? new Date(`${y}-${mo}-${dd}T${hh}:${mi}:${ss}+09:00`).getTime() : null;
  return { price: d.tradePrice, asOf, note: '정규장 기준' };
}, { Referer: 'https://finance.daum.net/', 'X-Requested-With': 'XMLHttpRequest' });

// 5. Yahoo (기준선)
await probe('Yahoo Finance', 'https://query1.finance.yahoo.com/v8/finance/chart/005930.KS?interval=1m&range=1d', (b) => {
  const m = JSON.parse(b).chart.result[0].meta;
  return { price: m.regularMarketPrice, asOf: m.regularMarketTime * 1000 };
});

// 6. Google Finance (비공식 경로 — 존재 확인용)
await probe('Google Finance', 'https://www.google.com/finance/quote/005930:KRX', (b) => {
  const m = b.match(/data-last-price="([\d.]+)"/);
  return { price: m?.[1], asOf: null, note: m ? 'HTML 파싱 필요' : '가격 패턴 불일치' };
});

// 7. stooq (한국 미지원 확인용)
await probe('stooq', 'https://stooq.com/q/l/?s=005930.kr&f=sd2t2ohlcv&h&e=csv', (b) => {
  const line = b.trim().split('\n')[1] ?? '';
  const [, , , , , , close] = line.split(',');
  return { price: close === 'N/D' ? null : close, asOf: null, note: line.includes('N/D') ? '데이터 없음(한국 미지원)' : '' };
});

// ── KOSPI 지수도 같은 방식으로 ──────────────────────────────────
console.log('\n【KOSPI 지수】\n');
await probe('네이버 지수', 'https://m.stock.naver.com/api/index/KOSPI/basic', (b) => {
  const d = JSON.parse(b);
  return { price: d.closePrice, asOf: d.localTradedAt ? new Date(d.localTradedAt).getTime() : null };
});
await probe('Yahoo 지수 ^KS11', 'https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=1d&range=1d', (b) => {
  const m = JSON.parse(b).chart.result[0].meta;
  return { price: m.regularMarketPrice, asOf: m.regularMarketTime * 1000 };
});

// ── 요약 ──────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(70));
console.log('폴백 체인 후보 (지연 낮은 순, 동작하는 것만)');
console.log('─'.repeat(70));
const usable = results.filter((r) => r.ok && r.price && r.lag !== null).sort((a, b) => a.lag - b.lag);
usable.forEach((r, i) => console.log(`  ${i + 1}. ${r.name.padEnd(24)} 지연 ${r.lag.toFixed(1)}분 · ${r.ms}ms`));
const noTime = results.filter((r) => r.ok && r.price && r.lag === null);
if (noTime.length) console.log(`\n  시각 정보 없음 (지연 측정 불가): ${noTime.map((r) => r.name).join(', ')}`);
const dead = results.filter((r) => !r.ok || !r.price);
if (dead.length) console.log(`  사용 불가: ${dead.map((r) => `${r.name}(${r.error ?? '가격없음'})`).join(', ')}`);
console.log(`\n  ⇒ 살아있는 실시간급 소스 ${usable.filter((r) => r.lag < 5).length}개, 지연 소스 ${usable.filter((r) => r.lag >= 5).length}개`);
