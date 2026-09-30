import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { unzip, parseCorpCodes, documentText, createDart } from '../lib/dart.mjs';

/** 테스트용 최소 ZIP (DART 응답과 같은 형태: 로컬 헤더 + 중앙 디렉터리 + EOCD) */
function zip(files, { method = 8 } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = method === 8 ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const CORP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<result>
  <list><corp_code>00164779</corp_code><corp_name>SK하이닉스</corp_name><corp_eng_name>SK hynix Inc.</corp_eng_name><stock_code>000660</stock_code><modify_date>20260101</modify_date></list>
  <list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name><corp_eng_name>SAMSUNG ELECTRONICS CO,.LTD</corp_eng_name><stock_code>005930</stock_code><modify_date>20260101</modify_date></list>
  <list><corp_code>00430964</corp_code><corp_name>굿앤엘에스</corp_name><corp_eng_name>Good &amp; LS Co.,Ltd.</corp_eng_name><stock_code> </stock_code><modify_date>20170630</modify_date></list>
  <list><corp_code>00999999</corp_code><corp_name>삼성전자서비스</corp_name><corp_eng_name>x</corp_eng_name><stock_code>999999</stock_code><modify_date>20260101</modify_date></list>
</result>`;

const DOC_XML = `<?xml version="1.0" encoding="utf-8"?>
<DOCUMENT><DOCUMENT-NAME ACODE="00760">조회공시요구(풍문또는보도)에대한답변(미확정)</DOCUMENT-NAME>
<COMPANY-NAME AREGCIK="00164779">에스케이하이닉스(주)</COMPANY-NAME><SUMMARY><EXTRACTION>x</EXTRACTION></SUMMARY>
<BODY><P>당사는 &quot;차세대 HBM 공급&quot; 관련 보도에 대해</P><P>현재 확정된 사항이 없습니다.</P>
<TABLE><TR><TD>구분</TD><TD>내용</TD></TR><TR><TD>재공시 예정일</TD><TD>2026-10-18</TD></TR></TABLE></BODY></DOCUMENT>`;

const HTML_DOC = `<html><head><meta content="text/html; charset=euc-kr" http-equiv="Content-Type"><style>.xforms * { font-family: 돋움체;} td { padding:0px; }</style>
<title>SK하이닉스/조회공시 요구(풍문 또는 보도)에 대한 답변(미확정)/(2026.09.18)조회공시 요구(풍문 또는 보도)에 대한 답변(미확정)</title></head>
<body><div class="xforms"><div class="xforms_title"><div><span>조회공시 요구(풍문 또는 보도)에 대한 답변(미확정)</span></div></div>
<table><tbody><tr><td width="138"><span>1. 제목</span></td><td><span class="xforms_input">SK하이닉스, 일본에 반도체 공장 짓는다 보도에 대한 조회공시 요구(2026.08.21)에 대한 답변</span></td></tr>
<tr><td><span>2. 내용</span></td><td><span>당사는 추가 생산기지 구축 등 다양한 방안을 검토하고 있으나, 현재까지 확정된 사항은 없습니다. <br xmlns:java="http://xml.apache.org/xalan/java">추후 3개월 이내 재공시 하겠습니다.</span></td></tr></tbody></table></div></body></html>`;

test('거래소 공시(HTML 형식)도 CSS 없이 본문만 읽는다 — 풍문 답변은 이 형식이다', () => {
  const d = documentText(HTML_DOC);
  assert.equal(d.company, 'SK하이닉스');
  assert.equal(d.title, '조회공시 요구(풍문 또는 보도)에 대한 답변(미확정)');
  assert.doesNotMatch(d.text, /font-family|padding|xforms/, 'CSS 가 본문으로 새지 않는다');
  assert.match(d.text, /1\. 제목 \| SK하이닉스, 일본에 반도체 공장 짓는다 보도/);
  assert.match(d.text, /확정된 사항은 없습니다\.\n추후 3개월 이내 재공시/, '속성 달린 <br> 도 줄바꿈');
});

test('ZIP — deflate·저장 방식 모두 풀고, ZIP 이 아니면 알아볼 수 있는 오류를 낸다', () => {
  assert.equal(unzip(zip({ 'a.xml': '가나다' }))['a.xml'].toString(), '가나다');
  assert.equal(unzip(zip({ 'b.xml': 'abc' }, { method: 0 }))['b.xml'].toString(), 'abc');
  assert.throws(() => unzip(Buffer.from('{"status":"010","message":"등록되지 않은 키"}')), /ZIP 이 아님/);
});

test('고유번호 목록에서 상장사만 남긴다 (종목코드 빈 칸 제외, 엔티티 해석)', () => {
  const corps = parseCorpCodes(CORP_XML);
  assert.deepEqual(corps.map((c) => c.stock_code), ['000660', '005930', '999999']);
  assert.equal(corps[0].corp_code, '00164779');
});

test('공시 XML → 제목·회사·본문 텍스트, 표는 | 로 잇는다', () => {
  const d = documentText(DOC_XML);
  assert.equal(d.title, '조회공시요구(풍문또는보도)에대한답변(미확정)');
  assert.equal(d.company, '에스케이하이닉스(주)');
  assert.match(d.text, /당사는 "차세대 HBM 공급" 관련 보도에 대해/);
  assert.match(d.text, /재공시 예정일 \| 2026-10-18/);
  assert.doesNotMatch(d.text, /EXTRACTION|<|&quot;/);
});

/** DART 를 흉내 내는 fetch — 호출된 URL 을 기록한다 */
function fakeDart(routes) {
  const calls = [];
  const fetch = async (url) => {
    const u = new URL(url);
    calls.push(u);
    const body = routes[u.pathname.split('/').pop()](u.searchParams);
    return Buffer.isBuffer(body)
      ? new Response(body, { status: 200 })
      : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, calls };
}

const dartWith = (routes, extra = {}) => {
  const f = fakeDart({ 'corpCode.xml': () => zip({ 'CORPCODE.xml': CORP_XML }), ...routes });
  const cacheFile = join(mkdtempSync(join(tmpdir(), 'sss-dart-')), 'corps.json');
  return { dart: createDart({ key: () => 'test-key', cacheFile, fetch: f.fetch, ...extra }), calls: f.calls, cacheFile };
};

test('회사 찾기 — 정확히 일치하는 이름이 먼저, 종목코드로도 찾는다', async () => {
  const { dart } = dartWith({});
  const hits = await dart.findCompany('삼성전자');
  assert.equal(hits[0].stock_code, '005930');
  assert.equal(hits[0].exact, true);
  assert.equal(hits[1].corp_name, '삼성전자서비스');
  assert.equal((await dart.findCompany('000660'))[0].corp_name, 'SK하이닉스');
  assert.equal((await dart.findCompany('hynix'))[0].stock_code, '000660', '영문 일부');
});

test('고유번호 목록은 한 번 받아 캐시한다 — 매 호출마다 30MB 를 받지 않는다', async () => {
  const { dart, calls, cacheFile } = dartWith({});
  await dart.findCompany('삼성');
  await dart.findCompany('하이닉스');
  assert.equal(calls.filter((u) => u.pathname.endsWith('corpCode.xml')).length, 1);
  const again = createDart({ key: () => 'k', cacheFile, fetch: async () => assert.fail('캐시가 있으면 받지 않는다') });
  assert.equal((await again.findCompany('삼성전자'))[0].stock_code, '005930');
});

test('공시 목록 — 종목코드를 고유번호로 바꿔 조회하고, 원문 링크를 붙인다', async () => {
  const { dart, calls } = dartWith({
    'list.json': (q) => ({
      status: '000', message: '정상', total_count: 1,
      list: [{ rcept_dt: '20260918', report_nm: '조회공시요구(풍문또는보도)에대한답변(미확정) ', flr_nm: 'SK하이닉스', rcept_no: '20260918800583', rm: '유', corp_code: q.get('corp_code') }],
    }),
  });
  const r = await dart.filings('000660', { from: '20260601', to: '20260927' });
  const list = calls.find((u) => u.pathname.endsWith('list.json'));
  assert.equal(list.searchParams.get('corp_code'), '00164779');
  assert.equal(list.searchParams.get('last_reprt_at'), 'Y', '정정 전 원본은 빼고 최종본만');
  assert.deepEqual(r.filings[0], {
    date: '2026-09-18', title: '조회공시요구(풍문또는보도)에대한답변(미확정)', filer: 'SK하이닉스', rcept_no: '20260918800583',
    remarks: '유', url: 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260918800583',
  });
});

test('DART 오류 코드 — 013(데이터 없음)은 빈 목록, 그 외는 메시지와 함께 실패', async () => {
  const empty = dartWith({ 'list.json': () => ({ status: '013', message: '조회된 데이타가 없습니다.' }) }).dart;
  assert.deepEqual((await empty.filings('005930')).filings, []);
  const bad = dartWith({ 'list.json': () => ({ status: '020', message: '사용한도를 초과하였습니다.' }) }).dart;
  await assert.rejects(bad.filings('005930'), /DART 020 사용한도를 초과/);
  await assert.rejects(bad.filings('123456'), /상장사 목록에 없는 종목코드/);
});

test('키가 없으면 발급 안내와 함께 실패한다', async () => {
  const { dart } = dartWith({}, { key: () => undefined });
  await assert.rejects(dart.findCompany('삼성'), /DART_API_KEY 미설정 .*opendart/);
});

test('공시 원문 — ZIP 을 풀어 텍스트로, 길면 자르고 표시한다', async () => {
  const { dart } = dartWith({ 'document.xml': () => zip({ '20260918800583.xml': DOC_XML }) });
  const r = await dart.filingText('20260918800583', { maxChars: 30 });
  assert.equal(r.title, '조회공시요구(풍문또는보도)에대한답변(미확정)');
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 30);
  assert.equal(r.source, 'https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260918800583');
});

test('방금 올라온 공시 — 원문 API 의 014(파일 없음)를 알아듣게 알리고, 감시는 열렸는지만 확인한다', async () => {
  const notYet = Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><result><status>014</status><message>파일이 존재하지 않습니다.</message></result>');
  let body = notYet;
  const { dart } = dartWith({ 'document.xml': () => body });
  await assert.rejects(dart.filingText('20260930800391'), /014 파일이 존재하지 않습니다\.? — 방금 올라온 공시는 원문이 API 에 늦게 열린다/);
  assert.equal(await dart.documentReady('20260930800391'), false);
  body = zip({ 'a.xml': DOC_XML });
  assert.equal(await dart.documentReady('20260930800391'), true);
  body = Buffer.from('<result><status>020</status><message>요청 제한</message></result>');
  await assert.rejects(dart.documentReady('1'), /020/);
  await assert.rejects(dart.filingText('1'), /DART 020 요청 제한/);
});

test('주요 계정 — 연결 기준을 고르고, 쉼표 숫자를 수로 바꾼다', async () => {
  const row = (fs, account, cur) => ({ fs_div: fs, sj_nm: '손익계산서', account_nm: account, thstrm_amount: cur, thstrm_dt: '2025.01.01 ~ 2025.12.31', frmtrm_amount: '-', frmtrm_dt: '', currency: 'KRW' });
  const { dart } = dartWith({
    'fnlttSinglAcnt.json': () => ({ status: '000', list: [row('OFS', '매출액', '1,000'), row('CFS', '매출액', '66,193,000,000,000'), row('CFS', '영업이익', '23,467,000,000,000')] }),
  });
  const r = await dart.financials('000660', { year: 2025 });
  assert.equal(r.basis, 'CFS');
  assert.deepEqual(r.accounts.map((a) => [a.account, a.current, a.previous]), [['매출액', 66193000000000, null], ['영업이익', 23467000000000, null]]);
});
