/**
 * Phase 0 스파이크: Codex 런타임 검증 (PLAN.md Phase 0 "Codex 런타임 검증" ①~④)
 *
 *   ⓪ MCP 서버 단독 동작 (Codex 없이 — 실패 원인을 Codex와 분리)
 *   ① 프로젝트 .codex/config.toml 의 MCP 도구를 codex exec 가 자율 호출
 *   ② 전역 ~/.codex/config.toml 의 MCP 서버가 섞여 들어오는지 + 격리 레시피로 막히는지
 *   ③ 샌드박스: 워크스페이스 밖 쓰기·셸 네트워크 차단, 그러면서 MCP 도구의 네트워크는 동작
 *   ④ 과금 경로: ChatGPT 로그인, CODEX_API_KEY 미설정
 *
 * 전제: codex 설치 + `codex login`(ChatGPT) + 레포 루트에서 `codex` 1회 실행해 trusted 등록
 * 실행: node verify.mjs            (원시 이벤트는 .runs/*.jsonl 에 남는다)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const CALL_LOG = join(HERE, '.calls.log');
const RUNS = join(HERE, '.runs');
mkdirSync(RUNS, { recursive: true });

const checks = [];
const notes = [];
const check = (name, pass, detail = '') => {
  checks.push([name, pass]);
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
};
const note = (text) => {
  notes.push(text);
  console.log(`  ⓘ ${text}`);
};

// 자식 프로세스에서 API 키 과금 경로를 원천 차단한다 (보고된 사고: CODEX_API_KEY 가 있으면 exec 가 API 과금으로 전환)
const childEnv = { ...process.env };
delete childEnv.CODEX_API_KEY;

const callLogLines = () => (existsSync(CALL_LOG) ? readFileSync(CALL_LOG, 'utf8').trim().split('\n').filter(Boolean) : []);

/** codex exec --json 1회 실행 → 이벤트 파싱 + 이 실행 동안 서버 측에 찍힌 도구 호출 */
function runExec(label, prompt, { sandbox = 'read-only', extra = [] } = {}) {
  const before = callLogLines().length;
  const args = ['exec', '--json', '--ephemeral', '-C', REPO, '-s', sandbox, ...extra];
  if (process.env.SSS_MODEL) args.push('-m', process.env.SSS_MODEL);
  args.push(prompt);

  const t0 = Date.now();
  const r = spawnSync('codex', args, { cwd: REPO, env: childEnv, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 << 20 });
  const seconds = (Date.now() - t0) / 1000;
  writeFileSync(join(RUNS, `${label}.jsonl`), r.stdout ?? '');
  writeFileSync(join(RUNS, `${label}.stderr.log`), r.stderr ?? '');

  const events = (r.stdout ?? '')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const items = events.filter((e) => e.type === 'item.completed').map((e) => e.item ?? {});
  const mcpCalls = items
    .filter((i) => i.type === 'mcp_tool_call')
    .map((i) => ({ server: i.server ?? i.server_name, tool: i.tool ?? i.tool_name, status: i.status, error: i.error ?? null }));
  const commands = items
    .filter((i) => i.type === 'command_execution')
    .map((i) => ({ command: i.command, exit: i.exit_code, output: (i.aggregated_output ?? '').slice(0, 300) }));
  const final = items.filter((i) => i.type === 'agent_message').map((i) => i.text).pop() ?? '';
  const usage = events.find((e) => e.type === 'turn.completed')?.usage ?? null;
  const failed = events.filter((e) => e.type === 'turn.failed' || e.type === 'error');
  const serverCalls = callLogLines().slice(before).map((l) => JSON.parse(l));

  console.log(`  ▸ ${label}: exit ${r.status} · ${seconds.toFixed(1)}s · MCP 호출 ${mcpCalls.map((c) => `${c.server}.${c.tool}`).join(', ') || '없음'}`);
  if (failed.length) console.log(`    실패 이벤트: ${JSON.stringify(failed).slice(0, 400)}`);
  if (r.status !== 0 && !events.length) console.log(`    stderr: ${(r.stderr ?? '').trim().split('\n').slice(-5).join(' | ')}`);
  return { status: r.status, seconds, events, mcpCalls, commands, final, usage, failed, serverCalls };
}

// ── ⓪ MCP 서버 단독 ────────────────────────────────────────────
console.log('\n【⓪】 MCP 서버 단독 동작 (Codex 없이)');
{
  const client = new Client({ name: 'verify', version: '0.0.1' });
  await client.connect(new StdioClientTransport({ command: 'node', args: [join(HERE, 'server.mjs')], stderr: 'ignore' }));
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  check('표준 MCP stdio 서버 기동 + 도구 5개 노출', names.length === 5, names.join(', '));
  const r = await client.callTool({ name: 'wiki_search', arguments: { q: '하이닉스' } });
  const hit = !r.isError && JSON.parse(r.content[0].text).rows.some((x) => x.id === 'company-sk-hynix');
  check('wiki_search 단독 호출 — "하이닉스" → company-sk-hynix (trigram)', hit);
  const s = await client.callTool({ name: 'find_similar_cases', arguments: { id: 'event-rubin-delay-rumor-2026' } });
  const sim = !s.isError && JSON.parse(s.content[0].text).some((x) => x.id === 'decision-hynix-reduce-2024');
  check('find_similar_cases 단독 호출 — 루빈 루머 → 2024 비중축소 판단 소환', sim);
  const f = await client.callTool({ name: 'recent_filings', arguments: { ticker: 'NVDA', limit: 2 } });
  check('recent_filings 단독 호출 — SEC 네트워크 정상', !f.isError, f.isError ? f.content[0].text.slice(0, 80) : '');
  await client.close();
}

// ── 전제 점검 ───────────────────────────────────────────────────
console.log('\n【전제】 Codex 설치·로그인·신뢰 등록');
const ver = spawnSync('codex', ['--version'], { encoding: 'utf8', env: childEnv });
if (ver.error) {
  console.log('  ⏸ codex 미설치 — `npm i -g @openai/codex` 후 `codex login`, 레포 루트에서 `codex` 1회 실행(신뢰 선택)');
  process.exit(2);
}
console.log(`  ▸ ${ver.stdout.trim()}`);
const login = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', env: childEnv });
const loginText = `${login.stdout}${login.stderr}`.trim();
if (login.status !== 0) {
  console.log(`  ⏸ 로그인 안 됨 — \`codex login\` 필요 (${loginText.split('\n')[0]})`);
  process.exit(2);
}
check('④ ChatGPT 계정으로 로그인됨 (API 키 아님)', /chatgpt/i.test(loginText), loginText.split('\n')[0]);
check('④ CODEX_API_KEY 환경변수 없음 (exec 가 API 과금으로 새지 않음)', !process.env.CODEX_API_KEY,
  process.env.CODEX_API_KEY ? '셸 프로필에서 제거할 것 — 이 스크립트는 자식 프로세스에서만 지운다' : '');
// auth.json 에 API 키와 ChatGPT 토큰이 공존하면 과금 경로가 흔들린다 (보고된 사례) — doctor 로 저장 상태를 본다
const doctor = spawnSync('codex', ['doctor'], { cwd: REPO, encoding: 'utf8', env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const stored = (key) => doctor.stdout?.match(new RegExp(`${key}\\s+(\\S+)`))?.[1];
check('④ auth.json 에 ChatGPT 토큰만 저장 (API 키 공존 없음)', stored('stored auth mode') === 'chatgpt' && stored('stored API key') === 'false',
  `mode=${stored('stored auth mode')} apiKey=${stored('stored API key')}`);
if (process.env.OPENAI_API_KEY) note('OPENAI_API_KEY 가 설정돼 있음 — Codex 는 무시한다고 하지만 브리핑 스크립트에서도 unset 권장');

const userCfgPath = join(homedir(), '.codex', 'config.toml');
const userCfg = existsSync(userCfgPath) ? readFileSync(userCfgPath, 'utf8') : '';
const globalServers = [...userCfg.matchAll(/^\[mcp_servers\.([^.\]]+)\]/gm)].map((m) => m[1]);
const trusted = userCfg.includes(`[projects."${REPO}"]`) && /trust_level\s*=\s*"trusted"/.test(userCfg);
console.log(`  ▸ 전역 MCP 서버: ${globalServers.join(', ') || '없음'}`);
if (!trusted) note(`이 레포가 trusted 로 보이지 않음 — 프로젝트 .codex/config.toml 이 무시될 수 있다. 레포 루트에서 \`codex\` 1회 실행해 신뢰 선택`);

// ── ① 프로젝트 MCP 자율 호출 ────────────────────────────────────
console.log('\n【①】 프로젝트 MCP 도구 자율 호출 (read-only 샌드박스)');
const a = runExec(
  'A-edgar',
  'NVDA의 최근 SEC 공시와 매출 추이를 도구로 조회해서, 확인된 사실만 3줄로 요약해줘. ' +
    '각 줄 끝에 근거 도구를 [도구명] 형태로 표기하고, 도구가 주지 않은 수치는 쓰지 마.',
);
const aTools = new Set(a.serverCalls.map((c) => c.tool));
check('codex exec 가 정상 종료', a.status === 0 && !a.failed.length);
check('프로젝트 MCP 서버(sss)의 도구를 스스로 골라 호출 (이벤트)', a.mcpCalls.some((c) => c.server === 'sss'));
check('서버 측 호출 기록과 일치 (.calls.log)', aTools.has('recent_filings') || aTools.has('xbrl_concept'), [...aTools].join(', '));
check('③ read-only 샌드박스에서도 MCP 도구의 네트워크는 동작 (SEC 응답 성공)', a.serverCalls.some((c) => c.ok));
check('답변이 도구 근거를 표기', /\[(recent_filings|xbrl_concept|sss[^\]]*)\]/.test(a.final), a.final.split('\n')[0]?.slice(0, 80));
if (a.usage) note(`토큰 사용: 입력 ${a.usage.input_tokens} (캐시 ${a.usage.cached_input_tokens}) / 출력 ${a.usage.output_tokens} · ${a.seconds.toFixed(1)}초 (Claude 기준선: 16초)`);

console.log('\n【①-b】 위키 루프 — 관계 탐색 + 유사 과거 판단 소환');
const b = runExec(
  'B-wiki',
  '위키 기준으로: SK하이닉스에 지금 영향을 주는 요인은 뭐고, 비슷했던 과거 사례에서 내가 어떤 판단을 했고 결과·교훈이 뭐였는지 찾아줘. ' +
    '위키 도구 결과에만 근거하고 각 줄에 [도구명]을 표기해.',
);
const bTools = new Set(b.serverCalls.map((c) => c.tool));
check('wiki_search 로 시작', bTools.has('wiki_search'), [...bTools].join(', '));
check('관계 탐색 또는 유사 케이스 도구까지 이어서 호출', bTools.has('wiki_graph_query') || bTools.has('find_similar_cases'));
check('과거 판단(2024 비중축소/블랙웰) 소환', /decision-hynix-reduce-2024|블랙웰|Blackwell/i.test(b.final));

// ── ② 전역 MCP 유입 ─────────────────────────────────────────────
const LEAK_PROMPT =
  '도구 점검만 해. 1) sss 서버의 wiki_search 로 "하이닉스"를 한 번 검색해. ' +
  '2) context7 서버의 도구가 지금 사용 가능하면 resolve-library-id 를 libraryName="zod" 로 딱 한 번 호출하고, 없으면 호출하지 마. ' +
  '3) 마지막 줄에 네가 지금 쓸 수 있는 MCP 서버 이름을 쉼표로 전부 나열해.';
const foreign = (run) => run.mcpCalls.filter((c) => c.server && c.server !== 'sss');

console.log('\n【②】 전역 MCP 유입 — 기본 실행');
const c = runExec('C-leak-default', LEAK_PROMPT);
const cLeak = foreign(c);
note(`기본 실행: 전역 서버 호출 ${cLeak.length ? cLeak.map((x) => `${x.server}.${x.tool}`).join(', ') + ' → 유입됨' : '없음'} · 자기보고: ${c.final.split('\n').pop()?.slice(0, 120)}`);

// 격리 레시피 (isolation.mjs 로 비교해 확정):
//   --ignore-user-config 는 신뢰 정보까지 끊어 프로젝트 서버도 사라지고, 대화형 codex 에는 그 옵션이 없다.
//   → 기능 끄기는 .codex/config.toml 에 두고, 전역 MCP 서버는 실행기가 이름별로 enabled=false 로 끈다.
console.log('\n【②-b】 격리 레시피 — 전역 서버 이름별 끄기 + 프로젝트 설정의 기능 끄기');
const offGlobals = globalServers.flatMap((n) => ['-c', `mcp_servers.${n}.enabled=false`]);
const d = runExec('D-leak-isolated', LEAK_PROMPT, { extra: offGlobals });
const dServers = d.final.split('\n').pop() ?? '';
check('격리 시 전역 MCP 서버 호출 없음', foreign(d).length === 0, foreign(d).map((x) => x.server).join(', '));
check('격리 시에도 프로젝트 서버(sss)는 동작', d.serverCalls.some((x) => x.tool === 'wiki_search'));
check('ChatGPT 커넥터(codex_apps)·전역 서버가 자기보고 목록에서 사라짐', !/codex_apps|context7|filesystem|github/.test(dServers), dServers.slice(0, 80));

// ── ③ 샌드박스 ──────────────────────────────────────────────────
// 모델에게 명령을 시키는 방식은 "실행 안 하고 실패했다고 보고"해도 통과해 버린다 (실제로 1회 발생 — 이벤트에 실행 기록 없음).
// 모델 없이 `codex sandbox -P :workspace`(workspace-write 에 해당하는 내장 프로필)로 같은 정책을 직접 건다.
console.log('\n【③】 샌드박스 — :workspace 프로필 직접 실행 (모델 개입 없음)');
const inside = join(HERE, '.probe-inside');
const outside = join(homedir(), '.sss-sandbox-probe');
rmSync(inside, { force: true });
rmSync(outside, { force: true });
const sb = (...cmd) => spawnSync('codex', ['sandbox', '-P', ':workspace', '-C', REPO, '--', ...cmd], { encoding: 'utf8', env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
const wIn = sb('sh', '-c', `echo probe > ${inside}`);
const wOut = sb('sh', '-c', `echo probe > ${outside}`);
const net = sb('curl', '-sS', '-m', '5', '-o', '/dev/null', 'https://www.sec.gov/');
check('워크스페이스 안 쓰기 허용', wIn.status === 0 && existsSync(inside), `exit ${wIn.status}`);
check('워크스페이스 밖(홈 디렉터리) 쓰기 차단', wOut.status !== 0 && !existsSync(outside), `exit ${wOut.status} ${wOut.stderr.trim().slice(0, 60)}`);
check('셸 네트워크 차단 (curl 실패)', net.status !== 0 && net.status !== null, `exit ${net.status} ${net.stderr.trim().slice(0, 60)}`);
rmSync(inside, { force: true });
rmSync(outside, { force: true });

// ── 요약 ────────────────────────────────────────────────────────
const passed = checks.filter(([, p]) => p).length;
console.log('\n' + '─'.repeat(60));
console.log(`검증 결과: ${passed}/${checks.length} 통과`);
for (const [name, p] of checks.filter(([, p]) => !p)) console.log(`  ❌ ${name}`);
console.log('관찰:');
for (const n of notes) console.log(`  ⓘ ${n}`);
console.log('수동 확인: `codex` 실행 → /status 로 방금 사용량이 ChatGPT 플랜 한도에서 차감됐는지 확인');
process.exit(passed === checks.length ? 0 : 1);
