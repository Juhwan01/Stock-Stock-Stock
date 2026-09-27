/**
 * Phase 0 스파이크: SEC EDGAR 공시 데이터 경로 검증 (API 키 불필요)
 *
 * SEC는 User-Agent 헤더에 연락 가능한 이메일을 요구한다.
 * 실행 전 EDGAR_UA 환경변수에 본인 연락처를 넣을 것:
 *   EDGAR_UA="Stock-Stock-Stock you@example.com" node edgar.mjs
 * 미설정 시 아래 placeholder로 시도한다 (SEC가 거부할 수 있음).
 */
const UA = process.env.EDGAR_UA ?? 'Stock-Stock-Stock-personal-research contact-not-set@example.com';
const RATE_LIMIT_MS = 110; // SEC 권고: IP당 초당 10건 이하

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function edgar(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  await sleep(RATE_LIMIT_MS);
  return res.json();
}

/** 티커 → CIK 매핑 (EDGAR의 모든 조회는 10자리 zero-padded CIK 기준) */
async function tickerToCik(ticker) {
  const map = await edgar('https://www.sec.gov/files/company_tickers.json');
  const hit = Object.values(map).find((c) => c.ticker === ticker.toUpperCase());
  if (!hit) throw new Error(`티커를 찾을 수 없음: ${ticker}`);
  return { cik: String(hit.cik_str).padStart(10, '0'), name: hit.title };
}

/** 최근 공시 목록 (8-K 등 이벤트 소스로 사용) */
async function recentFilings(cik, forms, limit) {
  const data = await edgar(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const r = data.filings.recent;
  const out = [];
  for (let i = 0; i < r.accessionNumber.length && out.length < limit; i++) {
    if (forms && !forms.includes(r.form[i])) continue;
    out.push({
      form: r.form[i],
      filed: r.filingDate[i],
      title: r.primaryDocDescription[i] || r.items[i] || '',
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${r.accessionNumber[i].replace(/-/g, '')}/${r.primaryDocument[i]}`,
    });
  }
  return { name: data.name, sic: data.sicDescription, filings: out };
}

/** XBRL 재무 팩트 — 구조화 수치라 LLM 추출 없이 그대로 신뢰 가능 */
async function revenueHistory(cik, quarters) {
  const data = await edgar(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/Revenues.json`);
  return (data.units.USD ?? [])
    .filter((u) => u.form === '10-Q' || u.form === '10-K')
    .slice(-quarters)
    .map((u) => ({ end: u.end, form: u.form, usd: u.val }));
}

const fmt = (n) => '$' + (n / 1e9).toFixed(2) + 'B';

async function main() {
  console.log(`User-Agent: ${UA}\n`);

  const { cik, name } = await tickerToCik('NVDA');
  console.log(`[1] 티커 → CIK   NVDA = ${name} (CIK ${cik})`);

  const { sic, filings } = await recentFilings(cik, ['8-K', '10-Q', '10-K'], 5);
  console.log(`[2] 업종        ${sic}`);
  console.log(`[3] 최근 공시 ${filings.length}건:`);
  for (const f of filings) console.log(`      ${f.filed}  ${f.form.padEnd(5)}  ${f.title.slice(0, 60)}`);

  const rev = await revenueHistory(cik, 4);
  console.log(`[4] XBRL 매출 시계열 (구조화 수치, LLM 추출 불필요):`);
  for (const r of rev) console.log(`      ${r.end}  ${r.form.padEnd(5)}  ${fmt(r.usd)}`);

  console.log(`\n✅ EDGAR 경로 검증 완료 — API 키 없이 회사 식별 / 공시 목록 / 재무 시계열 확보`);
}

main().catch((e) => {
  console.error(`❌ 실패: ${e.message}`);
  if (String(e.message).startsWith('403')) {
    console.error('   → SEC가 User-Agent를 거부했다. EDGAR_UA에 실제 연락 이메일을 설정할 것.');
  }
  process.exit(1);
});
