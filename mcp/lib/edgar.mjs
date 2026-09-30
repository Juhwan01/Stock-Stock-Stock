/**
 * SEC EDGAR — 키 불필요 (spikes/agent-sdk·codex-runtime 에서 이식)
 * SEC 는 연락처가 담긴 User-Agent 를 요구하고 IP당 초당 10건을 제한한다.
 */
const UA = () => process.env.EDGAR_UA ?? 'Stock-Stock-Stock-personal-research contact-not-set@example.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function edgar(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA(), 'Accept-Encoding': 'gzip, deflate' }, signal: AbortSignal.timeout(30e3) });
  if (!res.ok) throw new Error(`SEC ${res.status} — ${url}`);
  await sleep(110); // IP당 초당 10건 제한 준수
  return res.json();
}

let tickerMap = null;
export async function cikOf(ticker) {
  tickerMap ??= await edgar('https://www.sec.gov/files/company_tickers.json');
  const hit = Object.values(tickerMap).find((c) => c.ticker === ticker.toUpperCase());
  if (!hit) throw new Error(`알 수 없는 티커: ${ticker}`);
  return { cik: String(hit.cik_str).padStart(10, '0'), name: hit.title };
}

export async function recentFilings(ticker, limit = 5) {
  const { cik, name } = await cikOf(ticker);
  const source = `https://data.sec.gov/submissions/CIK${cik}.json`;
  const d = await edgar(source);
  const r = d.filings.recent;
  const filings = [];
  for (let i = 0; i < r.accessionNumber.length && filings.length < limit; i++) {
    const acc = r.accessionNumber[i];
    filings.push({
      accession: acc,
      form: r.form[i],
      filed: r.filingDate[i],
      items: r.items[i] || null,
      url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/${r.primaryDocument[i]}`,
    });
  }
  return { source, company: name, cik, sic: d.sicDescription, filings };
}

export async function xbrlConcept(ticker, concept = 'Revenues', limit = 4) {
  // 개념명은 URL 경로에 들어간다 — ../ 로 다른 경로를 치지 못하게 식별자만 받는다
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(concept)) throw new Error(`us-gaap 개념명이 아님: ${concept}`);
  const { cik, name } = await cikOf(ticker);
  const source = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`;
  const d = await edgar(source);
  // EPS 같은 개념은 USD 가 아니라 USD/shares 단위다
  const unit = d.units.USD ? 'USD' : Object.keys(d.units)[0];
  // 같은 기간이 여러 공시(10-Q, 이후 10-K 비교표)에 반복된다 — 가장 늦게 제출된 값만 남긴다
  const byPeriod = new Map();
  for (const u of d.units[unit] ?? []) {
    if (u.form !== '10-K' && u.form !== '10-Q') continue;
    const k = `${u.start ?? ''}~${u.end}`;
    if (!byPeriod.has(k) || byPeriod.get(k).filed < u.filed) byPeriod.set(k, u);
  }
  const series = [...byPeriod.values()]
    .sort((a, b) => a.end.localeCompare(b.end) || (a.start ?? '').localeCompare(b.start ?? ''))
    .slice(-limit)
    .map((u) => ({ start: u.start, end: u.end, form: u.form, fy: u.fy, fp: u.fp, filed: u.filed, value: u.val }));
  return { source, company: name, concept, unit, note: '기간(start~end)이 겹치면 누계치일 수 있으니 구분할 것', series };
}
