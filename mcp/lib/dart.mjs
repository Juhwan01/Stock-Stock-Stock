/**
 * DART 전자공시 OpenAPI — 한국 공시, 제품의 본체 (PLAN.md §4)
 *
 *  - 키: .env 의 DART_API_KEY (무료 개인키, 분당 1,000회). 서버가 읽고 Codex 에는 흐르지 않는다
 *  - DART 는 종목코드(6자리)가 아니라 고유번호(8자리)로 조회한다 → corpCode.xml(ZIP 안의 30MB XML)에서
 *    상장사만 뽑아 캐시한다 (약 4천 개, 7일마다 갱신)
 *  - 공시 원문(document.xml)도 ZIP 이다. 의존성을 늘리지 않으려고 ZIP 은 중앙 디렉터리만 읽는 최소 구현을 쓴다
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const API = 'https://opendart.fss.or.kr/api';
// 원문 API 가 아직 파일을 주지 않는다 — 방금 목록에 오른 공시는 원문이 늦게 열린다 (M3 실측)
export const DOC_NOT_READY = '014';
const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;

// DART 응답 코드 — 013 은 "데이터 없음"이라 오류가 아니다
const NO_DATA = '013';

/** ZIP → { 파일명: Buffer }. 저장(0)·deflate(8)만 지원 — DART 응답은 둘 중 하나다 */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP 이 아님 (EOCD 없음) — DART 가 오류를 JSON/XML 로 돌려줬을 수 있다');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 중앙 디렉터리 손상');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    // 로컬 헤더의 이름·확장 길이는 중앙 디렉터리와 다를 수 있어 로컬 헤더에서 다시 읽는다
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) out[name] = Buffer.from(data);
    else if (method === 8) out[name] = inflateRawSync(data);
    else throw new Error(`지원하지 않는 ZIP 압축 방식 ${method}: ${name}`);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** CORPCODE.xml → 상장사만 [{ corp_code, corp_name, corp_eng_name, stock_code }] */
export function parseCorpCodes(xml) {
  const corps = [];
  for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const f = (tag) => decode(m[1].match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? '').trim();
    const stock = f('stock_code');
    if (!/^\d{6}$/.test(stock)) continue;
    corps.push({ corp_code: f('corp_code'), corp_name: f('corp_name'), corp_eng_name: f('corp_eng_name'), stock_code: stock });
  }
  return corps;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}

/**
 * 공시 원문 → 읽을 수 있는 텍스트. 표는 셀을 | 로 잇는다.
 * 원문은 두 형식이다: 정기·주요사항 보고서는 DART 자체 XML(대문자 태그), 거래소 공시(풍문 답변 등)는
 * HTML(xforms — <head> 에 CSS 가 통째로 들어 있다). 둘 다 태그만 걷어 내면 같은 방식으로 읽힌다.
 */
export function documentText(xml) {
  const htmlTitle = decode(xml.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '').trim(); // "회사/보고서명/(날짜)보고서명"
  const title = decode(xml.match(/<DOCUMENT-NAME[^>]*>([^<]*)</)?.[1] ?? '').trim() || htmlTitle.split('/')[1]?.trim() || htmlTitle;
  const company = decode(xml.match(/<COMPANY-NAME[^>]*>([^<]*)</)?.[1] ?? '').trim() || (htmlTitle.includes('/') ? htmlTitle.split('/')[0].trim() : '');
  const body = xml
    .replace(/<\?xml[^>]*>/g, '')
    .replace(/<(head|style|script)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(DOCUMENT-NAME|FORMULA-VERSION|COMPANY-NAME|SUMMARY)[\s\S]*?<\/\1>/g, '')
    .replace(/<\/(TD|TH|TE|TU)>/gi, ' | ')
    .replace(/<\/(P|TR|TITLE|COVER-TITLE|SECTION-\d|TABLE|DIV|LI)>|<BR\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((l) => decode(l).replace(/[ \t\u00a0]+/g, ' ').replace(/^(\s*\|\s*)+|(\s*\|\s*)+$/g, '').trim())
    .filter(Boolean)
    .join('\n');
  return { title, company, text: body };
}

const kstDay = (offsetDays = 0) =>
  new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10).replace(/-/g, '');

export function createDart({ key = () => process.env.DART_API_KEY, cacheFile, fetch: fetchImpl = globalThis.fetch } = {}) {
  const apiKey = () => {
    const k = key();
    if (!k) {
      const e = new Error('DART_API_KEY 미설정 — https://opendart.fss.or.kr 에서 인증키 신청 후 레포의 .env 에 DART_API_KEY=... 로 넣는다');
      e.code = 'NO_KEY';
      throw e;
    }
    return k;
  };

  async function call(path, params) {
    const qs = new URLSearchParams({ crtfc_key: apiKey(), ...params });
    // 원문 ZIP 은 클 수 있어 넉넉히. 멈춘 응답이 감시·도구를 붙잡지 않게 끊는다
    const res = await fetchImpl(`${API}/${path}?${qs}`, { signal: AbortSignal.timeout(60e3) });
    if (!res.ok) throw new Error(`DART HTTP ${res.status} — ${path}`);
    return res;
  }

  async function json(path, params) {
    const d = await (await call(path, params)).json();
    if (d.status === NO_DATA) return { ...d, list: [] };
    if (d.status !== '000') throw new Error(`DART ${d.status} ${d.message} — ${path}`);
    return d;
  }

  let corps = null;
  async function listedCorps({ refresh = false } = {}) {
    if (corps && !refresh) return corps;
    const fresh = cacheFile && existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < CACHE_TTL_MS;
    if (fresh && !refresh) {
      corps = JSON.parse(readFileSync(cacheFile, 'utf8'));
      return corps;
    }
    const buf = Buffer.from(await (await call('corpCode.xml', {})).arrayBuffer());
    const files = unzip(buf);
    const xml = files['CORPCODE.xml'] ?? Object.values(files)[0];
    corps = parseCorpCodes(xml.toString('utf8'));
    if (cacheFile) {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(corps));
    }
    return corps;
  }

  /** 6자리 종목코드 → 상장사 레코드 */
  async function corpOf(stockCode) {
    const hit = (await listedCorps()).find((c) => c.stock_code === stockCode);
    if (!hit) throw new Error(`상장사 목록에 없는 종목코드: ${stockCode} — find_company 로 먼저 찾는다`);
    return hit;
  }

  return {
    listedCorps,

    /** 회사명·종목코드로 상장사 찾기. 정확히 일치하는 것이 먼저 온다 */
    async findCompany(query, limit = 10) {
      const q = query.trim().toLowerCase().replace(/\s+/g, '');
      const norm = (s) => s.toLowerCase().replace(/\s+/g, '');
      const all = await listedCorps();
      const scored = all
        .map((c) => {
          const names = [norm(c.corp_name), norm(c.corp_eng_name)];
          const score = c.stock_code === q || names.includes(q) ? 0 : names.some((n) => n.startsWith(q)) ? 1 : names.some((n) => n.includes(q)) ? 2 : 9;
          return { c, score };
        })
        .filter((x) => x.score < 9)
        .sort((a, b) => a.score - b.score || a.c.corp_name.length - b.c.corp_name.length);
      return scored.slice(0, limit).map((x) => ({ ...x.c, exact: x.score === 0 }));
    },

    /** 공시 목록. 기본은 최근 90일 */
    async filings(stockCode, { from = kstDay(-90), to = kstDay(), type, limit = 20, page = 1, finalOnly = true } = {}) {
      const corp = await corpOf(stockCode);
      const d = await json('list.json', {
        corp_code: corp.corp_code,
        bgn_de: from,
        end_de: to,
        page_no: String(page),
        page_count: String(Math.min(limit, 100)),
        ...(type && { pblntf_ty: type }),
        ...(finalOnly && { last_reprt_at: 'Y' }),
      });
      return {
        source: 'DART list.json',
        company: corp.corp_name,
        stock_code: stockCode,
        corp_code: corp.corp_code,
        period: `${from}~${to}`,
        total: Number(d.total_count ?? d.list.length),
        filings: d.list.slice(0, limit).map((x) => ({
          date: `${x.rcept_dt.slice(0, 4)}-${x.rcept_dt.slice(4, 6)}-${x.rcept_dt.slice(6, 8)}`,
          title: x.report_nm.trim(),
          filer: x.flr_nm,
          rcept_no: x.rcept_no,
          remarks: x.rm || null, // 유: 유가증권 · 코: 코스닥 · 정: 정정 · 연: 연결 포함 · 공: 공정위
          url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${x.rcept_no}`,
        })),
      };
    },

    /** 원문 API 가 파일을 주는지 — 목록에 오른 직후에는 014(파일 없음)를 준다. 감시가 해석을 미룰지 정한다 */
    async documentReady(rceptNo) {
      // 첫 조각만 읽고 끊는다 — 열린 원문 ZIP 을 매번 통째로 받지 않게
      const res = await call('document.xml', { rcept_no: rceptNo });
      const reader = res.body.getReader();
      const { value } = await reader.read();
      await reader.cancel().catch(() => {});
      const buf = Buffer.from(value ?? []);
      if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return true;
      const status = buf.toString('utf8', 0, 400).match(/<status>(\d+)<\/status>/)?.[1];
      if (status === DOC_NOT_READY) return false;
      throw new Error(`DART document.xml ${status ?? '응답이 ZIP 이 아님'} — ${rceptNo}`);
    },

    /** 공시 원문 텍스트 (앞부분). 표는 | 로 이어진 행으로 나온다 */
    async filingText(rceptNo, { maxChars = 6000 } = {}) {
      const buf = Buffer.from(await (await call('document.xml', { rcept_no: rceptNo })).arrayBuffer());
      if (!(buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50)) {
        // ZIP 대신 오류 XML — 원인을 그대로 알린다
        const head = buf.toString('utf8', 0, 400);
        const status = head.match(/<status>(\d+)<\/status>/)?.[1];
        const message = head.match(/<message>([^<]*)<\/message>/)?.[1];
        if (status === DOC_NOT_READY) throw new Error(`DART 014 ${message ?? '파일 없음'} — 방금 올라온 공시는 원문이 API 에 늦게 열린다. 공시 뷰어 링크를 안내하고 나중에 다시 읽는다`);
        if (status) throw new Error(`DART ${status} ${message ?? ''} — document.xml`);
      }
      const files = unzip(buf);
      const parts = Object.entries(files)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, b]) => ({ name, ...documentText(b.toString('utf8')) }));
      const text = parts.map((p) => (parts.length > 1 ? `## ${p.name}\n${p.text}` : p.text)).join('\n\n');
      return {
        source: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rceptNo}`,
        rcept_no: rceptNo,
        title: parts[0]?.title ?? null,
        company: parts[0]?.company ?? null,
        chars_total: text.length,
        truncated: text.length > maxChars,
        text: text.slice(0, maxChars),
      };
    },

    /** 주요 계정 (매출·영업이익·순이익 등). report: 11013 1분기 · 11012 반기 · 11014 3분기 · 11011 사업보고서 */
    async financials(stockCode, { year, report = '11011', consolidated = true } = {}) {
      const corp = await corpOf(stockCode);
      const d = await json('fnlttSinglAcnt.json', { corp_code: corp.corp_code, bsns_year: String(year), reprt_code: report });
      const want = consolidated ? 'CFS' : 'OFS';
      let rows = d.list.filter((r) => r.fs_div === want);
      const fallback = !rows.length && d.list.length;
      if (fallback) rows = d.list;
      const num = (s) => (s && s !== '-' ? Number(String(s).replace(/,/g, '')) : null);
      return {
        source: 'DART fnlttSinglAcnt.json',
        company: corp.corp_name,
        year,
        report,
        basis: fallback ? `${rows[0]?.fs_div} (${want} 없음)` : want,
        currency: rows[0]?.currency ?? 'KRW',
        accounts: rows.map((r) => ({
          statement: r.sj_nm,
          account: r.account_nm,
          current: num(r.thstrm_amount),
          current_period: r.thstrm_dt,
          previous: num(r.frmtrm_amount),
          previous_period: r.frmtrm_dt,
        })),
      };
    },
  };
}
