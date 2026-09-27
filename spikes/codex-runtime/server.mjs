/**
 * Phase 0 스파이크: Codex 런타임 검증용 도메인 도구 MCP 서버 (stdio)
 *
 * Claude SDK 전용 tool() 래퍼 대신 표준 MCP로 감싼다 — Codex·Claude Code 양쪽에서 붙는지가 요점.
 * 로직은 기존 스파이크를 그대로 재사용한다: EDGAR(spikes/agent-sdk) · 위키 인덱스(spikes/wiki).
 *
 * stdout은 MCP 프로토콜 전용이다. 로그는 stderr, 호출 기록은 .calls.log(JSONL)에 남긴다 —
 * Codex의 이벤트 스트림과 독립된 두 번째 증거로 verify.mjs가 대조한다.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, search, traverse, findSimilarCases } from '../wiki/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CALL_LOG = join(HERE, '.calls.log');
const WIKI_DIR = process.env.SSS_WIKI_DIR ?? join(HERE, '../wiki/wiki');
const UA = process.env.EDGAR_UA ?? 'Stock-Stock-Stock-personal-research contact-not-set@example.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const logCall = (tool, args, ok) =>
  appendFileSync(CALL_LOG, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, tool, args, ok }) + '\n');

const text = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true });

/** 호출 기록 + 예외를 도구 에러로 변환하는 공통 래퍼 */
const handler = (name, fn) => async (args) => {
  try {
    const out = await fn(args);
    logCall(name, args, true);
    return text(out);
  } catch (e) {
    logCall(name, args, false);
    return fail(e.message);
  }
};

// ── EDGAR (spikes/agent-sdk/agent.mjs 에서 이식) ─────────────────
async function edgar(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
  if (!res.ok) throw new Error(`SEC ${res.status} — ${url}`);
  await sleep(110); // IP당 초당 10건 제한 준수
  return res.json();
}

let tickerMap = null;
async function cikOf(ticker) {
  tickerMap ??= await edgar('https://www.sec.gov/files/company_tickers.json');
  const hit = Object.values(tickerMap).find((c) => c.ticker === ticker.toUpperCase());
  if (!hit) throw new Error(`알 수 없는 티커: ${ticker}`);
  return { cik: String(hit.cik_str).padStart(10, '0'), name: hit.title };
}

// ── 위키 인덱스: 기동 시 마크다운에서 메모리 SQLite로 재구축 ─────
const { db, stats } = buildIndex(WIKI_DIR);
process.stderr.write(`[sss] wiki index: ${stats.nodes} nodes / ${stats.edges} edges from ${WIKI_DIR}\n`);

const server = new McpServer(
  { name: 'sss', version: '0.0.1' },
  {
    instructions:
      '개인 투자 리서치 도구. 모든 사실은 이 서버 도구가 반환한 데이터에만 근거하고, 답변 각 줄에 근거 도구를 [도구명]으로 표기한다. ' +
      '도구가 주지 않은 수치·사실은 쓰지 않고 "확인하지 않음"으로 구분한다. 위키 질문은 wiki_search로 시작해 wiki_graph_query로 관계를 넓힌다. ' +
      'SEC EDGAR는 초당 10건 제한이 있으니 같은 티커를 반복 조회하지 않는다.',
  },
);

server.registerTool(
  'recent_filings',
  {
    description: '미국 상장사의 최근 SEC 공시 목록(양식·제출일·8-K 항목)을 조회한다. 이벤트 발생 여부 확인용.',
    inputSchema: { ticker: z.string().describe('티커 심볼, 예: NVDA'), limit: z.number().int().min(1).max(20).default(5) },
  },
  handler('recent_filings', async ({ ticker, limit }) => {
    const { cik, name } = await cikOf(ticker);
    const d = await edgar(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const r = d.filings.recent;
    const filings = [];
    for (let i = 0; i < r.accessionNumber.length && filings.length < limit; i++) {
      filings.push({ form: r.form[i], filed: r.filingDate[i], items: r.items[i] || null });
    }
    return { source: `https://data.sec.gov/submissions/CIK${cik}.json`, company: name, cik, filings };
  }),
);

server.registerTool(
  'xbrl_concept',
  {
    description: 'SEC XBRL에서 재무 항목 시계열(10-K/10-Q)을 가져온다. 구조화 수치라 추정 없이 그대로 쓸 수 있다.',
    inputSchema: {
      ticker: z.string(),
      concept: z.string().default('Revenues').describe('us-gaap 개념명, 예: Revenues, NetIncomeLoss'),
      limit: z.number().int().min(1).max(12).default(4),
    },
  },
  handler('xbrl_concept', async ({ ticker, concept, limit }) => {
    const { cik, name } = await cikOf(ticker);
    const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`;
    const d = await edgar(url);
    const series = (d.units.USD ?? [])
      .filter((u) => u.form === '10-K' || u.form === '10-Q')
      .slice(-limit)
      .map((u) => ({ start: u.start, end: u.end, form: u.form, fy: u.fy, fp: u.fp, usd: u.val }));
    return { source: url, company: name, concept, note: '기간(start~end)이 겹치면 누계치일 수 있으니 구분할 것', series };
  }),
);

server.registerTool(
  'wiki_search',
  {
    description: '투자 위키 전문검색. 한국어 부분어 지원(3글자 이상 trigram, 2글자 이하 LIKE 폴백).',
    inputSchema: { q: z.string().min(1), limit: z.number().int().min(1).max(20).default(5) },
  },
  handler('wiki_search', async ({ q, limit }) => search(db, q, limit)),
);

server.registerTool(
  'wiki_graph_query',
  {
    description: '위키 노드에서 관계 그래프를 k-hop 탐색한다. as_of(YYYY-MM-DD)를 주면 그 시점에 유효했던 관계만 따라간다.',
    inputSchema: {
      id: z.string().describe('노드 id, 예: company-sk-hynix'),
      hops: z.number().int().min(1).max(3).default(2),
      as_of: z.string().optional(),
    },
  },
  handler('wiki_graph_query', async ({ id, hops, as_of }) => traverse(db, id, { hops, asOf: as_of ?? null })),
);

server.registerTool(
  'find_similar_cases',
  {
    description: '현재 상황 노드와 유사한 과거 Decision(당시 논지·결과·교훈 포함)을 소환한다.',
    inputSchema: { id: z.string().describe('현재 상황 노드 id, 예: event-rubin-delay-rumor-2026') },
  },
  handler('find_similar_cases', async ({ id }) => findSimilarCases(db, id)),
);

await server.connect(new StdioServerTransport());
