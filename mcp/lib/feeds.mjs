/**
 * 장중 감시의 원천 (PLAN.md M3) — 모델 없이 코드가 새 항목을 가져온다
 *
 *  - DART 전체 공시 목록(list.json, 회사 지정 없음): 한 번 호출로 시장 전체의 최신 공시 — 종목 수와 무관하게 20초 폴링이 된다.
 *    게시 시각 순이다(접수번호 순이 아니다 — 00·80·90 계열이 섞인다, 2026-09-30 실측). 새 항목은 위에 붙으므로
 *    이미 본 항목이 나오는 페이지에서 멈춘다. 순서를 벗어나 게시된 것은 감시의 종목별 점검이 잡는다
 *  - EDGAR getcurrent(Atom): 미국 전체의 최신 공시. 한 공시가 제출자·발행사마다 한 줄씩 나온다
 *  - 언론사 RSS: 제목만 쓴다. 비상업·개인 이용만 허용되고 연합뉴스는 "AI 학습 및 활용 금지"라 모델에 넘기지 않는다
 *
 * 파서는 의존성 없이 필요한 태그만 읽는다. 테스트는 fetch 를 바꿔 넣는다
 */
const DART_API = 'https://opendart.fss.or.kr/api';
// 응답이 멈추면 감시 한 바퀴가 몇 분씩 묶인다 (undici 기본은 헤더까지 300초) — 코드 리뷰
const TIMEOUT_MS = 20e3;
const timeout = () => AbortSignal.timeout(TIMEOUT_MS);
const EDGAR_CURRENT = 'https://www.sec.gov/cgi-bin/browse-edgar';

export const NEWS_FEEDS = [
  { name: '연합뉴스 경제', url: 'https://www.yna.co.kr/rss/economy.xml' },
  { name: '연합뉴스 마켓+', url: 'https://www.yna.co.kr/rss/market.xml' },
  { name: '한국경제 증권', url: 'https://www.hankyung.com/feed/finance' },
  { name: '매일경제 증권', url: 'https://www.mk.co.kr/rss/50200011/' },
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeXml(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
        return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .replace(/\s+/g, ' ')
    .trim();
}
const tag = (block, name) => decodeXml(block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i'))?.[1] ?? '');
const ymd = (d) => d.replace(/-/g, '');
const dash = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

// ── DART ─────────────────────────────────────────────────────────
/**
 * 시장 전체의 최신 공시. 이미 본 id(seen)가 나오는 페이지까지만 넘긴다 — 처음 돌 때는 pages 까지.
 * 다 넘기고도 본 항목을 못 만났으면 truncated — 그 사이는 종목별 점검(sweep)이 메운다
 * @returns { items: [{ id, rcept_no, date, corp_name, stock_code, corp_cls, title, filer, remarks, url }], truncated }
 */
export async function dartLatest({ key, from, to, seen = new Set(), pages = 3, fetch = globalThis.fetch }) {
  if (!key) throw Object.assign(new Error('DART_API_KEY 미설정 — 한국 공시 감시 꺼짐'), { code: 'NO_KEY' });
  const items = [];
  const got = new Set(); // 넘기는 사이 새 항목이 위에 붙으면 앞 페이지 끝 항목이 다음 페이지에 또 나온다
  for (let page = 1; page <= pages; page++) {
    const qs = new URLSearchParams({ crtfc_key: key, bgn_de: ymd(from), end_de: ymd(to), page_no: String(page), page_count: '100' });
    const res = await fetch(`${DART_API}/list.json?${qs}`, { signal: timeout() });
    if (!res.ok) throw new Error(`DART HTTP ${res.status} — list.json`);
    const d = await res.json();
    if (d.status === '013') return { items, truncated: false };
    if (d.status !== '000') throw new Error(`DART ${d.status} ${d.message} — list.json`);
    let hit = false;
    for (const x of d.list ?? []) {
      const id = `dart:${x.rcept_no}`;
      if (seen.has(id)) {
        hit = true;
        continue;
      }
      if (got.has(id)) continue;
      got.add(id);
      items.push({
        id, rcept_no: x.rcept_no, date: dash(x.rcept_dt), corp_name: x.corp_name, stock_code: x.stock_code || null, corp_cls: x.corp_cls,
        title: String(x.report_nm ?? '').trim(), filer: x.flr_nm, remarks: x.rm || null,
        url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${x.rcept_no}`,
      });
    }
    if (hit || page >= Number(d.total_page ?? 1)) return { items, truncated: false };
  }
  return { items, truncated: true };
}

// ── EDGAR ────────────────────────────────────────────────────────
/** getcurrent Atom → [{ accession, form, company, cik, role, url, updated }] — 같은 공시가 역할마다 한 줄씩 */
export function parseEdgarAtom(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const title = tag(e, 'title'); // "8-K - NVIDIA CORP (0001045810) (Filer)"
    const t = title.match(/^(.+?) - (.+) \((\d{10})\) \(([^)]+)\)$/);
    const accession = e.match(/accession-number=([\d-]+)/)?.[1];
    if (!t || !accession) continue;
    out.push({
      accession, form: t[1].trim(), company: t[2].trim(), cik: t[3], role: t[4],
      url: decodeXml(e.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? ''),
      updated: tag(e, 'updated'),
    });
  }
  return out;
}

/** 미국 전체의 최신 공시 (내부자 보고 제외 — 기계적 공시라 푸시하지 않는다). seen 을 만날 때까지 페이지를 넘긴다 */
export async function edgarCurrent({ ua, seen = new Set(), pages = 3, fetch = globalThis.fetch }) {
  const entries = [];
  for (let page = 0; page < pages; page++) {
    const qs = new URLSearchParams({ action: 'getcurrent', type: '', company: '', dateb: '', owner: 'exclude', start: String(page * 100), count: '100', output: 'atom' });
    const res = await fetch(`${EDGAR_CURRENT}?${qs}`, { headers: { 'User-Agent': ua, 'Accept-Encoding': 'gzip, deflate' }, signal: timeout() });
    if (!res.ok) throw new Error(`SEC HTTP ${res.status} — getcurrent`);
    // SEC 는 ISO-8859-1 로 준다
    const got = parseEdgarAtom(new TextDecoder('latin1').decode(await res.arrayBuffer()));
    entries.push(...got.filter((x) => !seen.has(`sec:${x.accession}`)));
    if (!got.length || got.some((x) => seen.has(`sec:${x.accession}`))) return { entries, truncated: false };
  }
  return { entries, truncated: true };
}

// ── RSS ──────────────────────────────────────────────────────────
/** RSS 2.0 → [{ title, link, published }] */
export function parseRss(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/g)) {
    const title = tag(m[1], 'title');
    const link = tag(m[1], 'link') || tag(m[1], 'guid');
    if (!title || !/^https?:\/\//.test(link)) continue;
    const t = Date.parse(tag(m[1], 'pubDate'));
    out.push({ title, link, published: Number.isFinite(t) ? new Date(t).toISOString() : null });
  }
  return out;
}

export async function fetchRss(feed, { fetch = globalThis.fetch } = {}) {
  const res = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0 (personal news reader)' }, signal: timeout() });
  if (!res.ok) throw new Error(`${feed.name} HTTP ${res.status}`);
  return parseRss(await res.text()).map((x) => ({ ...x, source: feed.name }));
}
