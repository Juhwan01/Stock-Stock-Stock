/**
 * Phase 0 스파이크: 아키텍처 전체 경로 검증
 *
 *   내 Claude 구독 자격증명 → Agent SDK → 커스텀 도메인 도구 → 실시간 SEC 데이터 → 근거 있는 답변
 *
 * 이 스파이크가 통과하면 제품의 뼈대가 성립함이 증명된다:
 *   1. 배포용 API 키 없이 로컬 구독 인증으로 에이전트가 돈다
 *   2. 우리 도메인 도구(공시/시세/위키)를 에이전트가 스스로 골라 호출한다
 *   3. 답변이 도구가 반환한 실제 데이터에 근거한다 (환각 아님)
 *
 * 실행: EDGAR_UA="Stock-Stock-Stock you@example.com" node agent.mjs
 */
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const UA = process.env.EDGAR_UA ?? 'Stock-Stock-Stock-personal-research contact-not-set@example.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const toolCalls = [];

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

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `ERROR: ${msg}` }], isError: true });

const filingsTool = tool(
  'recent_filings',
  '미국 상장사의 최근 SEC 공시 목록을 조회한다. 이벤트 발생 여부를 확인할 때 사용.',
  { ticker: z.string().describe('티커 심볼, 예: NVDA'), limit: z.number().default(5) },
  async ({ ticker, limit }) => {
    try {
      const { cik, name } = await cikOf(ticker);
      toolCalls.push(`recent_filings(${ticker})`);
      const d = await edgar(`https://data.sec.gov/submissions/CIK${cik}.json`);
      const r = d.filings.recent;
      const rows = [];
      for (let i = 0; i < r.accessionNumber.length && rows.length < limit; i++) {
        rows.push({ form: r.form[i], filed: r.filingDate[i], items: r.items[i] || null });
      }
      return ok({ company: name, cik, sic: d.sicDescription, filings: rows });
    } catch (e) {
      return fail(e.message);
    }
  },
);

const financialsTool = tool(
  'xbrl_concept',
  'SEC XBRL에서 특정 재무 항목의 시계열을 가져온다. 구조화 수치라 추정 없이 그대로 신뢰할 수 있다.',
  {
    ticker: z.string(),
    concept: z.string().default('Revenues').describe('us-gaap 개념명, 예: Revenues, NetIncomeLoss, Assets'),
    limit: z.number().default(4),
  },
  async ({ ticker, concept, limit }) => {
    try {
      const { cik, name } = await cikOf(ticker);
      toolCalls.push(`xbrl_concept(${ticker}, ${concept})`);
      const d = await edgar(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`);
      const series = (d.units.USD ?? [])
        .filter((u) => u.form === '10-K' || u.form === '10-Q')
        .slice(-limit)
        .map((u) => ({ start: u.start, end: u.end, form: u.form, fy: u.fy, fp: u.fp, usd: u.val }));
      return ok({ company: name, concept, unit: 'USD', note: '기간(start~end)이 겹치면 누계치일 수 있으니 반드시 구분할 것', series });
    } catch (e) {
      return fail(`${e.message} (해당 개념이 없을 수 있음)`);
    }
  },
);

const server = createSdkMcpServer({
  name: 'market-data',
  version: '0.1.0',
  tools: [filingsTool, financialsTool],
});

const PROMPT = `NVDA의 최근 공시와 매출 시계열을 도구로 조회해서, 확인된 사실만 3줄로 요약해줘.
각 줄 끝에 근거가 된 도구 이름을 [도구명] 형태로 표기할 것. 도구가 주지 않은 수치는 절대 쓰지 마.`;

console.log('▶ 프롬프트:', PROMPT.split('\n')[0], '\n');

let answer = '';
let usage = null;
let model = null;

for await (const msg of query({
  prompt: PROMPT,
  options: {
    mcpServers: { 'market-data': server },
    allowedTools: ['mcp__market-data__recent_filings', 'mcp__market-data__xbrl_concept'],
    permissionMode: 'bypassPermissions', // 스파이크: 커스텀 도구만 노출된 상태라 안전
    maxTurns: 8,
    systemPrompt: '너는 개인 투자 리서치 보조다. 반드시 도구가 반환한 데이터에만 근거해 답하고, 추측은 명시적으로 구분한다.',
  },
})) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    model = msg.model;
    console.log(`▶ 모델: ${msg.model}`);
    console.log(`▶ 노출된 도구: ${msg.tools.filter((t) => t.startsWith('mcp__')).join(', ')}\n`);
  }
  if (msg.type === 'assistant') {
    for (const block of msg.message.content) {
      if (block.type === 'tool_use') console.log(`  🔧 호출: ${block.name} ${JSON.stringify(block.input)}`);
      if (block.type === 'text' && block.text.trim()) answer = block.text;
    }
  }
  if (msg.type === 'result') {
    usage = { turns: msg.num_turns, ms: msg.duration_ms, cost: msg.total_cost_usd, subtype: msg.subtype };
  }
}

console.log('\n▶ 최종 답변:\n');
console.log(answer.split('\n').map((l) => '  ' + l).join('\n'));

console.log('\n' + '─'.repeat(60));
console.log('검증 결과');
console.log('─'.repeat(60));
console.log(`  구독 인증으로 SDK 구동     : ${model ? '✅ ' + model : '❌'}`);
console.log(`  커스텀 도구 실제 호출      : ${toolCalls.length ? '✅ ' + toolCalls.join(', ') : '❌ 호출 안 됨'}`);
console.log(`  라이브 SEC 데이터 반영     : ${/\d/.test(answer) ? '✅' : '❌'}`);
console.log(`  턴/소요/비용               : ${usage?.turns}턴 / ${(usage?.ms / 1000).toFixed(1)}s / ${usage?.cost === 0 ? '구독 한도 차감(추가 과금 0)' : '$' + usage?.cost}`);
