#!/usr/bin/env node
/**
 * sss 도메인 도구 MCP 서버 (stdio) — 투자 리서치 에이전트의 "손"
 *
 * bin/sss.mjs 가 Codex 에 이 서버를 주입한다. 서버는 Codex 샌드박스 밖에서 도는 별도 프로세스이므로
 *  - 외부 데이터(DART·EDGAR·시세)는 여기서만 가져온다 (에이전트의 셸은 네트워크가 막혀 있다 — Phase 0 실측)
 *  - API 키는 서버가 레포의 .env 에서 직접 읽어 도구 경로로는 Codex 에 흐르지 않는다.
 *    단 샌드박스는 디스크 읽기를 막지 않아 에이전트 셸이 .env 를 읽을 수는 있다 — AGENTS.md 규칙이 유일한 방어선
 *  - 모든 호출을 var/calls.jsonl 에 남긴다 — 모델 자기보고와 무관한 기록. 에이전트가 고칠 수 없도록
 *    쓰기 범위(wiki/) 밖에 둔다. 코드 레포 안이지만 gitignore 라 push 되지 않는다
 *
 * stdout 은 MCP 프로토콜 전용이다. 로그는 stderr 로만 쓴다.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWiki, search, traverse, findSimilarCases, EDGE_RELS } from './lib/wiki.mjs';
import { recordShape, updateShape, recordDecision, updateDecision, openDecisions } from './lib/decision.mjs';
import { recentFilings, xbrlConcept } from './lib/edgar.mjs';
import { createDart } from './lib/dart.mjs';
import { quote, history } from './lib/quotes.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(REPO, '.env'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
const WIKI_DIR = process.env.SSS_WIKI_DIR ?? join(REPO, 'wiki');
const CALL_LOG = process.env.SSS_CALL_LOG ?? join(REPO, 'var', 'calls.jsonl');
mkdirSync(dirname(CALL_LOG), { recursive: true });

// 라이선스상 opt-in 이 필요한 시세 소스는 모델이 아니라 사용자 설정(.env)으로만 켠다 — 도구 인자로 노출하지 않는다.
// 이 opt-in 은 휘발성 현재가(quote)에만 쓴다. 위키 정본인 price_history 는 설정과 무관하게 공식 소스만.
const allowUnlicensed = process.env.SSS_ALLOW_UNLICENSED === '1';
const allowElevatedRisk = process.env.SSS_ALLOW_ELEVATED_RISK === '1';

const wiki = createWiki(join(WIKI_DIR, 'pages'), { root: WIKI_DIR });
const dart = createDart({ cacheFile: join(REPO, 'var', 'dart-corps.json') });

const logCall = (tool, args, ok, error) =>
  appendFileSync(
    CALL_LOG,
    JSON.stringify({ at: new Date().toISOString(), pid: process.pid, wiki: WIKI_DIR, tool, args, ok, ...(error && { error }) }) + '\n',
  );

const describeError = (e) =>
  e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.') || '(입력)'}: ${i.message}`).join('; ') : e.message;

/** 호출 기록 + 예외를 도구 에러로 변환하는 공통 래퍼 */
const handler = (name, fn) => async (args) => {
  try {
    const out = await fn(args);
    logCall(name, args, true);
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
  } catch (e) {
    const msg = describeError(e);
    logCall(name, args, false, msg);
    return { content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true };
  }
};

const server = new McpServer(
  { name: 'sss', version: '0.1.0' },
  {
    instructions:
      '개인 투자 리서치 도구. 사실은 이 서버 도구 결과와 출처 있는 위키 페이지에만 근거하고, 답변 각 줄에 근거 도구를 [도구명]으로 표기한다. ' +
      '도구가 주지 않은 수치는 쓰지 않는다. 위키 질문은 wiki_search → wiki_graph_query → find_similar_cases 순으로 넓힌다. ' +
      'decision_record/decision_update 는 사용자가 대화에서 내용을 확인한 뒤에만 user_confirmed=true 로 호출한다. ' +
      'quote 결과(official=false)는 휘발성이라 위키에 옮겨 적지 않는다. 자세한 규칙은 AGENTS.md.',
  },
);

// ── 위키 ────────────────────────────────────────────────────────
server.registerTool(
  'wiki_search',
  {
    description: '투자 위키 전문검색. 입력 문자열을 부분 문자열로 찾는다(3글자 이상 trigram, 2글자 이하 LIKE). 여러 개념은 각각 따로 검색한다.',
    inputSchema: { q: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) },
  },
  handler('wiki_search', async ({ q, limit }) => search(wiki.get().db, q, limit)),
);

server.registerTool(
  'wiki_graph_query',
  {
    description: '위키 노드에서 관계 그래프를 k-hop 탐색한다. as_of(YYYY-MM-DD)를 주면 그 시점에 유효했던 관계만 따라간다(바이템포럴).',
    inputSchema: {
      id: z.string().describe('노드 id, 예: company-sk-hynix'),
      hops: z.number().int().min(1).max(3).default(2),
      as_of: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      rels: z.array(z.enum([...EDGE_RELS, 'mentions'])).optional().describe('따라갈 관계 종류 제한'),
    },
  },
  handler('wiki_graph_query', async ({ id, hops, as_of, rels }) => traverse(wiki.get().db, id, { hops, asOf: as_of ?? null, rels: rels ?? null })),
);

server.registerTool(
  'find_similar_cases',
  {
    description: '현재 상황 노드와 유사한 과거 Decision(당시 논지·확신도·결과·교훈)을 소환한다. 태그 겹침과 similar-to 링크를 본다.',
    inputSchema: { id: z.string().describe('현재 상황 노드 id, 예: event-rubin-delay-rumor-2026') },
  },
  handler('find_similar_cases', async ({ id }) => findSimilarCases(wiki.get().db, id)),
);

server.registerTool(
  'wiki_status',
  {
    description: '위키 상태 점검: 노드·엣지 수, 읽지 못한 페이지, 모양이 틀린 엣지, 필수 필드 누락, 없는 노드를 가리키는 링크, 스키마 밖 관계, 결과 미기록 판단 목록.',
    inputSchema: {},
  },
  handler('wiki_status', async () => {
    const { db, stats } = wiki.get();
    return {
      wiki: WIKI_DIR,
      ...stats,
      open_decisions: openDecisions(db).map((d) => ({
        id: d.id, title: d.title, date: d.date, invalidation_condition: d.decision.invalidation_condition,
      })),
    };
  }),
);

server.registerTool(
  'decision_record',
  {
    description:
      '투자 판단을 Decision 페이지로 기록한다. 논지·확신도·무효화 조건이 필수다. 무효화 조건이 애매하면 먼저 데이터/이벤트/날짜로 판정 가능한 형태로 다듬어 사용자 확인을 받는다. ' +
      'about/triggered_by 노드가 위키에 없으면 거부된다.',
    inputSchema: recordShape,
  },
  handler('decision_record', async (args) => recordDecision(wiki, args)),
);

server.registerTool(
  'decision_update',
  {
    description: '열린 Decision 에 실제 결과·괴리·교훈을 기록하고 닫는다. 교훈은 결과가 아니라 판단 프로세스를 평가한다.',
    inputSchema: updateShape,
  },
  handler('decision_update', async (args) => updateDecision(wiki, args)),
);

// ── 데이터: 한국 공시 (DART) ────────────────────────────────────
const stockCode = z.string().regex(/^\d{6}$/).describe('6자리 종목코드, 예: 000660. 모르면 find_company');
const yyyymmdd = z.string().regex(/^\d{8}$/);

server.registerTool(
  'find_company',
  {
    description: '한국 상장사를 회사명(한글·영문 일부) 또는 종목코드로 찾는다. 결과의 stock_code 를 다른 도구에 쓴다.',
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) },
  },
  handler('find_company', async ({ query, limit }) => dart.findCompany(query, limit)),
);

server.registerTool(
  'dart_filings',
  {
    description:
      '한국 상장사의 DART 공시 목록 (기본 최근 90일, 최종본만). 공시 유형 type: A 정기 · B 주요사항 · C 발행 · D 지분 · E 기타 · I 거래소. ' +
      '제목만으로 판단하지 말고 중요해 보이면 dart_filing_text 로 본문을 읽는다.',
    inputSchema: {
      code: stockCode,
      from: yyyymmdd.optional().describe('YYYYMMDD'),
      to: yyyymmdd.optional().describe('YYYYMMDD'),
      type: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'I', 'J']).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
  },
  handler('dart_filings', async ({ code, from, to, type, limit }) => dart.filings(code, { from, to, type, limit })),
);

server.registerTool(
  'dart_filing_text',
  {
    description: 'DART 공시 원문 텍스트(앞부분). rcept_no 는 dart_filings 결과에서. 표는 셀을 | 로 이은 행으로 나온다. truncated 면 max_chars 를 늘린다.',
    inputSchema: {
      rcept_no: z.string().regex(/^\d{14}$/),
      max_chars: z.number().int().min(500).max(40000).default(6000),
    },
  },
  handler('dart_filing_text', async ({ rcept_no, max_chars }) => dart.filingText(rcept_no, { maxChars: max_chars })),
);

server.registerTool(
  'dart_financials',
  {
    description: 'DART 주요 재무 계정(매출·영업이익·순이익·자산 등). report: 11013 1분기 · 11012 반기 · 11014 3분기 · 11011 사업보고서. 기본 연결(CFS).',
    inputSchema: {
      code: stockCode,
      year: z.number().int().min(2015).max(2100),
      report: z.enum(['11013', '11012', '11014', '11011']).default('11011'),
      consolidated: z.boolean().default(true),
    },
  },
  handler('dart_financials', async ({ code, year, report, consolidated }) => dart.financials(code, { year, report, consolidated })),
);

// ── 데이터: 미국 공시 ───────────────────────────────────────────
server.registerTool(
  'recent_filings',
  {
    description: '미국 상장사의 최근 SEC 공시 목록(양식·제출일·8-K 항목·원문 URL). 이벤트 발생 확인용.',
    inputSchema: { ticker: z.string().describe('티커, 예: NVDA'), limit: z.number().int().min(1).max(20).default(5) },
  },
  handler('recent_filings', async ({ ticker, limit }) => recentFilings(ticker, limit)),
);

server.registerTool(
  'xbrl_concept',
  {
    description: 'SEC XBRL 재무 항목 시계열(10-K/10-Q). 구조화 수치라 추정 없이 그대로 쓸 수 있다.',
    inputSchema: {
      ticker: z.string(),
      concept: z.string().default('Revenues').describe('us-gaap 개념명, 예: Revenues, NetIncomeLoss, OperatingIncomeLoss'),
      limit: z.number().int().min(1).max(12).default(4),
    },
  },
  handler('xbrl_concept', async ({ ticker, concept, limit }) => xbrlConcept(ticker, concept, limit)),
);

// ── 데이터: 한국 시세 ───────────────────────────────────────────
server.registerTool(
  'quote',
  {
    description:
      '한국 종목 현재가(6자리 코드, 예: 005930). 휘발성 조회 전용 — 결과의 official=false 면 위키에 저장하지 않는다. ' +
      '기본은 야후(약 20분 지연). 실시간 포털 소스는 사용자가 .env 에서 켰을 때만 쓰인다. 지연(lagMinutes)을 답에 함께 표기한다.',
    inputSchema: { code: z.string().regex(/^\d{6}$/) },
  },
  handler('quote', async ({ code }) => quote(code, { allowUnlicensed, allowElevatedRisk })),
);

server.registerTool(
  'price_history',
  {
    description:
      '한국 종목 일별 시세 히스토리(공공데이터포털, T+1). 위키에 남길 수 있는 정본 시세다. ' +
      '공식 키가 없으면 비공식으로 조용히 폴백하지 않고 발급 안내와 함께 실패한다.',
    inputSchema: {
      code: z.string().regex(/^\d{6}$/),
      from: z.string().regex(/^\d{8}$/).optional().describe('YYYYMMDD'),
      to: z.string().regex(/^\d{8}$/).optional().describe('YYYYMMDD'),
    },
  },
  handler('price_history', async ({ code, from, to }) => history(code, { from, to })), // allowUnlicensed 를 넘기지 않는다
);

await server.connect(new StdioServerTransport());
process.stderr.write(`[sss] ready · wiki ${WIKI_DIR}\n`);
