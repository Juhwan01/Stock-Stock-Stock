/**
 * Phase 0 스파이크: 공시 → 이벤트·관계 추출 → 위키 페이지 생성 (파이프라인 전체)
 *
 * 이것이 제품의 심장이다. DART 키가 없어 EDGAR로 검증하지만 파이프라인 형태는 동일하다:
 *   공시 원문 → LLM이 스키마에 맞춰 이벤트/엔티티/관계 추출 → 마크다운 위키 페이지 → SQLite 인덱스
 *
 * 검증할 것
 *   1. LLM이 정해진 노드/엣지 스키마를 지켜 쓰는가 (자유 서술이 아니라 구조화)
 *   2. 기존 위키를 읽고 중복 엔티티를 만들지 않는가 (Zep의 핵심 교훈)
 *   3. 모든 사실에 출처를 붙이는가 (팩트 기반 규율)
 *   4. 생성된 페이지가 인덱서에 그대로 물리는가 (스키마 왕복)
 *
 * 실행: EDGAR_UA="Stock-Stock-Stock you@example.com" node extract.mjs
 */
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const WIKI = join(here, 'wiki');
const UA = process.env.EDGAR_UA ?? 'Stock-Stock-Stock-personal-research contact-not-set@example.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 기존 위키를 씨앗으로 복사 — 중복 엔티티를 만드는지 보려면 이미 아는 엔티티가 있어야 한다.
if (existsSync(WIKI)) rmSync(WIKI, { recursive: true });
mkdirSync(WIKI, { recursive: true });
const SEED = join(here, '..', 'wiki', 'wiki');
for (const f of readdirSync(SEED)) writeFileSync(join(WIKI, f), readFileSync(join(SEED, f)));
const seedFiles = readdirSync(WIKI);
console.log(`씨앗 위키: ${seedFiles.length}개 페이지 (${seedFiles.map((f) => f.replace('.md', '')).join(', ')})\n`);

// ── 공시 조회 도구 ────────────────────────────────────────────────
async function edgar(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate' } });
  if (!res.ok) throw new Error(`SEC ${res.status}`);
  await sleep(110);
  return res.json();
}

let tickerMap = null;
const fetchFiling = tool(
  'fetch_filings',
  '미국 상장사의 최근 SEC 공시 목록과 메타데이터를 가져온다.',
  { ticker: z.string(), limit: z.number().default(3) },
  async ({ ticker, limit }) => {
    tickerMap ??= await edgar('https://www.sec.gov/files/company_tickers.json');
    const hit = Object.values(tickerMap).find((c) => c.ticker === ticker.toUpperCase());
    if (!hit) return { content: [{ type: 'text', text: `ERROR: 알 수 없는 티커 ${ticker}` }], isError: true };
    const cik = String(hit.cik_str).padStart(10, '0');
    const d = await edgar(`https://data.sec.gov/submissions/CIK${cik}.json`);
    const r = d.filings.recent;
    const rows = [];
    for (let i = 0; i < r.accessionNumber.length && rows.length < limit; i++) {
      if (!['8-K', '10-Q', '10-K'].includes(r.form[i])) continue;
      rows.push({
        form: r.form[i], filed: r.filingDate[i], items: r.items[i] || null,
        url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${r.accessionNumber[i].replace(/-/g, '')}/${r.primaryDocument[i]}`,
      });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ company: d.name, ticker: hit.ticker, cik, sic: d.sicDescription, filings: rows }, null, 2) }] };
  },
);

// ── 스키마 정의를 프롬프트에 주입 ─────────────────────────────────
const SCHEMA = `
## 위키 페이지 스키마 (반드시 준수)

프론트매터 YAML + 본문 마크다운. 노드 타입은 다음 중 하나:
  Company(ticker 필수) · Person · Sector · Theme · MacroIndicator · Event(date·sources 필수) · Decision · Source

엣지 관계는 다음 중에서만 고른다:
  causes · affects(direction: "+" 또는 "-") · supplies-to · customer-of · competes-with
  belongs-to · precedes · similar-to · triggered-by · resulted-in · invalidated-by · derived-from · about

형식:
---
id: <kebab-case-고유id>
type: Event
title: <제목>
date: YYYY-MM-DD
tags: [태그1, 태그2]
sources:
  - "<출처 URL>"
edges:
  - rel: affects
    to: <대상 노드 id>
    direction: "-"
    confidence: 0.7          # 0~1, 근거가 약하면 낮게
    valid_from: YYYY-MM-DD
    note: <이 관계를 그렇게 본 근거>
---

<본문. 확인된 사실만. 추론은 "추정:"으로 명시 구분. [[다른-페이지-id]]로 링크>
`;

const PROMPT = `너는 개인 투자 리서치 위키를 관리하는 에이전트다.

작업: NVDA의 최근 SEC 공시를 조회하고, 그중 가장 최근 8-K 하나를 위키 Event 페이지로 만들어라.

절차:
1. 먼저 Glob 과 Read 로 위키 디렉터리(${WIKI})의 기존 페이지를 확인해라. 어떤 엔티티가 이미 존재하는지 파악하는 것이 중요하다.
2. fetch_filings 로 NVDA 공시를 가져와라.
3. 가장 최근 8-K를 Event 페이지로 작성해 Write 로 저장해라.

엄수할 규칙:
- **기존 엔티티를 재사용해라.** 이미 company-nvidia 페이지가 있다면 새로 만들지 말고 그 id로 연결해라. 중복 엔티티 생성은 심각한 오류다.
- **모든 사실에 출처를 붙여라.** sources 에 실제 공시 URL을 넣어라.
- **도구가 준 정보만 사실로 써라.** 8-K 본문을 읽지 않았다면 항목 코드만 있고 내용은 모른다는 것을 명시해라. 내용을 지어내지 마라.
- confidence 는 근거의 강도를 정직하게 반영해라. 항목 코드만 보고 영향을 추정했다면 낮게 잡아라.

${SCHEMA}`;

// ── 실행 ──────────────────────────────────────────────────────────
const server = createSdkMcpServer({ name: 'edgar', version: '0.1.0', tools: [fetchFiling] });
const toolLog = [];

console.log('▶ 에이전트 실행 중…\n');
let answer = '', model = null, usage = null, exposedTools = [];

for await (const msg of query({
  prompt: PROMPT,
  options: {
    mcpServers: { edgar: server },
    // 실측으로 확인한 격리 설정 — 없으면 개발환경 MCP 54개가 유입된다.
    settingSources: [],
    strictMcpConfig: true,
    allowedTools: ['mcp__edgar__fetch_filings', 'Read', 'Write', 'Glob', 'Grep'],
    disallowedTools: ['Bash', 'Task', 'WebFetch', 'WebSearch', 'NotebookEdit'],
    permissionMode: 'bypassPermissions',
    cwd: WIKI,
    maxTurns: 20,
    systemPrompt: '너는 팩트 기반 투자 리서치 위키 관리자다. 도구가 반환한 데이터에만 근거하고, 추론은 반드시 명시적으로 구분한다.',
  },
})) {
  if (msg.type === 'system' && msg.subtype === 'init') {
    model = msg.model;
    exposedTools = msg.tools;
    const foreign = msg.tools.filter((t) => t.startsWith('mcp__') && !t.startsWith('mcp__edgar__'));
    console.log(`  모델 ${msg.model} · 노출 도구 ${msg.tools.length}개 · 외부 MCP 유입 ${foreign.length}개 ${foreign.length ? '⚠️' : '✅'}`);
    console.log(`  빌트인: ${msg.tools.filter((t) => !t.startsWith('mcp__')).join(', ')}`);
  }
  if (msg.type === 'assistant') {
    for (const b of msg.message.content) {
      if (b.type === 'tool_use') {
        toolLog.push(b.name);
        const arg = b.name === 'Write' ? b.input.file_path?.split('/').pop() : JSON.stringify(b.input).slice(0, 60);
        console.log(`  🔧 ${b.name} ${arg}`);
      }
      if (b.type === 'text' && b.text.trim()) answer = b.text;
    }
  }
  if (msg.type === 'result') usage = { turns: msg.num_turns, ms: msg.duration_ms };
}

console.log(`\n  ${usage?.turns}턴 / ${(usage?.ms / 1000).toFixed(1)}초\n`);

// ── 검증 ──────────────────────────────────────────────────────────
const after = readdirSync(WIKI);
const created = after.filter((f) => !seedFiles.includes(f));
console.log('─'.repeat(64));
console.log('검증');
console.log('─'.repeat(64));

const checks = [];
const chk = (n, p, d = '') => { checks.push([n, p]); console.log(`  ${p ? '✅' : '❌'} ${n}${d ? '  — ' + d : ''}`); };

chk('새 페이지 생성됨', created.length > 0, created.join(', '));
chk('기존 페이지를 덮어쓰지 않음', seedFiles.every((f) => after.includes(f)));
chk('기존 위키를 먼저 읽음', toolLog.some((t) => t === 'Read' || t === 'Glob'));

// 하드코딩하지 말 것 — 실제 노출 목록으로 검사한다.
const foreignMcp = exposedTools.filter((t) => t.startsWith('mcp__') && !t.startsWith('mcp__edgar__'));
chk('외부 MCP 도구 유입 없음', foreignMcp.length === 0, `${exposedTools.length}개 중 외부 ${foreignMcp.length}개`);

// disallowedTools 가 실제로 막았는지, 그리고 허용하지 않은 빌트인이 새어나오는지 확인
const blocked = ['Bash', 'Task', 'WebFetch', 'WebSearch', 'NotebookEdit'];
const leaked = blocked.filter((t) => exposedTools.includes(t));
chk('차단 지정 도구가 실제로 차단됨', leaked.length === 0, leaked.length ? `누출: ${leaked.join(', ')}` : '');
const unrequested = exposedTools.filter((t) => !t.startsWith('mcp__') && !['Read', 'Write', 'Glob', 'Grep'].includes(t));
if (unrequested.length) console.log(`  ℹ️  요청하지 않았으나 노출된 빌트인 ${unrequested.length}개: ${unrequested.join(', ')}`);
const usedUnrequested = toolLog.filter((t) => unrequested.includes(t));
chk('에이전트가 요청 외 빌트인을 실제로 쓰지 않음', usedUnrequested.length === 0,
  usedUnrequested.length ? `사용됨: ${[...new Set(usedUnrequested)].join(', ')}` : '');

if (created.length) {
  const raw = readFileSync(join(WIKI, created[0]), 'utf8');
  console.log(`\n─── 생성된 페이지: ${created[0]} ───`);
  console.log(raw.split('\n').slice(0, 32).map((l) => '  ' + l).join('\n'));

  const { parsePage, buildIndex, search, traverse } = await import('../wiki/index.mjs');
  let parsed = null;
  try { parsed = parsePage(join(WIKI, created[0])); } catch (e) { console.log(`\n  파싱 실패: ${e.message}`); }

  console.log();
  chk('인덱서가 파싱 가능 (스키마 왕복)', !!parsed);
  if (parsed) {
    const validNodes = ['Company', 'Person', 'Sector', 'Theme', 'MacroIndicator', 'Event', 'Decision', 'Source'];
    const validRels = ['causes','affects','supplies-to','customer-of','competes-with','belongs-to','precedes','similar-to','triggered-by','resulted-in','invalidated-by','derived-from','about'];
    const edges = parsed.fm.edges ?? [];
    const badRels = edges.filter((e) => !validRels.includes(e.rel)).map((e) => e.rel);

    chk('노드 타입이 스키마 내', validNodes.includes(parsed.fm.type), parsed.fm.type);
    chk('엣지 관계가 전부 스키마 내', badRels.length === 0, badRels.length ? `위반: ${badRels.join(', ')}` : `${edges.length}개 관계`);
    chk('출처 URL 존재', (parsed.fm.sources ?? []).some((s) => String(s).startsWith('http')));
    chk('날짜 존재', !!parsed.fm.date);

    // 중복 엔티티 검사 — 이것이 가장 중요하다
    const existingIds = seedFiles.map((f) => f.replace('.md', ''));
    const refs = edges.map((e) => e.to);
    const reused = refs.filter((r) => existingIds.includes(r));
    const dangling = refs.filter((r) => !existingIds.includes(r) && !after.includes(r + '.md'));
    chk('기존 엔티티를 재사용함 (중복 생성 안 함)', reused.length > 0, reused.length ? `재사용: ${reused.join(', ')}` : '연결 없음');
    if (dangling.length) console.log(`  ⚠️  존재하지 않는 노드 참조: ${dangling.join(', ')}`);
  }

  // 인덱스 왕복 — 생성된 페이지가 검색·탐색에 잡히는가
  const { db, stats } = buildIndex(WIKI);
  const hit = search(db, 'NVDA', 5).rows.concat(search(db, '엔비디아', 5).rows);
  chk('인덱스 구축 성공', stats.nodes === after.length, `${stats.nodes}노드 / ${stats.edges}엣지`);
  chk('새 페이지가 그래프에 연결됨', traverse(db, 'company-nvidia', { hops: 1 }).some((r) => r.id === created[0].replace('.md', '')));
}

console.log(`\n  ${checks.filter(([, p]) => p).length}/${checks.length} 통과`);
process.exit(checks.every(([, p]) => p) ? 0 : 1);
