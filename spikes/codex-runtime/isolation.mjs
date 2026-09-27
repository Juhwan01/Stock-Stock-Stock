/**
 * Phase 0 스파이크: Codex 도구 격리 방법 비교
 *
 * verify.mjs 에서 드러난 문제:
 *   - 기본 실행이면 전역 ~/.codex/config.toml 의 MCP 서버(context7·filesystem·github)가 섞여 들어온다
 *   - --ignore-user-config 는 전역 서버를 끊지만, 신뢰 정보도 사용자 설정에 있어 프로젝트 서버(sss)까지 사라진다
 *   - codex_apps(ChatGPT 계정 커넥터)는 설정 파일과 무관하게 붙는다
 *
 * 변형별로 (a) sss 도구 호출 가능 여부 (b) 전역 서버 호출 여부 (c) 자기보고 도구 목록을 비교한다.
 * 실행: node isolation.mjs      (원시 이벤트: .runs/iso-*.jsonl)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const CALL_LOG = join(HERE, '.calls.log');
const RUNS = join(HERE, '.runs');
mkdirSync(RUNS, { recursive: true });

const env = { ...process.env };
delete env.CODEX_API_KEY;

// 리서치 에이전트에 필요 없는 도구 노출 기능 — 화이트리스트 방식으로 전부 끈다
const DISABLE = [
  'apps', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'multi_agent',
  'plugins', 'remote_plugin', 'tool_suggest', 'skill_search', 'skill_mcp_dependency_install', 'goals', 'in_app_browser',
];
const disableFlags = DISABLE.flatMap((f) => ['--disable', f]);
// 사용자 설정을 끊고 우리 서버만 CLI로 주입한다. 승인 모드를 함께 넘기지 않으면 exec(승인 정책 never)에서 호출이 거부된다
const injectSss = [
  '-c', 'mcp_servers.sss.command="node"',
  '-c', 'mcp_servers.sss.args=["spikes/codex-runtime/server.mjs"]',
  '-c', 'mcp_servers.sss.default_tools_approval_mode="approve"',
];
const noWeb = ['-c', 'web_search="disabled"'];
// 대화형 codex 에는 --ignore-user-config 가 없다 → 전역 서버를 이름으로 하나씩 끈다 (프로젝트 설정·신뢰는 유지)
const userCfgPath = join(homedir(), '.codex', 'config.toml');
const globalNames = existsSync(userCfgPath)
  ? [...readFileSync(userCfgPath, 'utf8').matchAll(/^\[mcp_servers\.([^.\]]+)\]/gm)].map((m) => m[1]).filter((n) => n !== 'sss')
  : [];
const offGlobals = globalNames.flatMap((n) => ['-c', `mcp_servers.${n}.enabled=false`]);
const trustViaFlag = ['-c', `projects."${REPO}".trust_level="trusted"`];

const VARIANTS = [
  { label: 'default', extra: [] },
  { label: 'ignore-user-config+trust-flag', extra: ['--ignore-user-config', ...trustViaFlag] },
  { label: 'ignore-user-config+inject-sss', extra: ['--ignore-user-config', ...injectSss] },
  { label: 'ignore-user-config+inject-sss+disable', extra: ['--ignore-user-config', ...injectSss, ...disableFlags] },
  { label: 'default+disable', extra: [...disableFlags] },
  { label: 'ignore-user-config+inject-sss+disable+no-web', extra: ['--ignore-user-config', ...injectSss, ...disableFlags, ...noWeb] },
  { label: 'globals-off+disable+no-web', extra: [...offGlobals, ...disableFlags, ...noWeb] },
  { label: 'globals-off+project-config', extra: [...offGlobals] }, // 기능 끄기를 .codex/config.toml 에 둔 경우
];
// node isolation.mjs [라벨 일부...] — 주면 해당 변형만 실행
const only = process.argv.slice(2);
const selected = only.length ? VARIANTS.filter((v) => only.some((o) => v.label.includes(o))) : VARIANTS;

const PROMPT =
  '도구 격리 점검이다. 1) sss 서버의 wiki_search 가 있으면 q="하이닉스"로 한 번 호출해. ' +
  '2) context7 서버 도구가 있으면 resolve-library-id 를 libraryName="zod" 로 한 번 호출하고, 없으면 호출하지 마. ' +
  '3) 마지막 줄은 "TOOLS: " 로 시작해서, 지금 너에게 노출된 모든 도구(함수) 이름을 빠짐없이 쉼표로 나열해. MCP 도구는 서버명을 포함해.';

const callLines = () => (existsSync(CALL_LOG) ? readFileSync(CALL_LOG, 'utf8').trim().split('\n').filter(Boolean) : []);

const rows = [];
for (const v of selected) {
  const before = callLines().length;
  const t0 = Date.now();
  const r = spawnSync('codex', ['exec', '--json', '--ephemeral', '-C', REPO, '-s', 'read-only', ...v.extra, PROMPT], {
    cwd: REPO, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'],
  });
  writeFileSync(join(RUNS, `iso-${v.label}.jsonl`), r.stdout ?? '');
  writeFileSync(join(RUNS, `iso-${v.label}.stderr.log`), r.stderr ?? '');
  const items = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === 'item.completed').map((e) => e.item);
  const mcp = items.filter((i) => i.type === 'mcp_tool_call').map((i) => `${i.server}.${i.tool}`);
  const final = items.filter((i) => i.type === 'agent_message').map((i) => i.text).pop() ?? '';
  const tools = (final.match(/TOOLS:\s*(.*)$/m)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const sssOk = callLines().slice(before).some((l) => JSON.parse(l).tool === 'wiki_search');
  const foreign = mcp.filter((m) => !m.startsWith('sss.'));
  rows.push({ label: v.label, exit: r.status, s: ((Date.now() - t0) / 1000).toFixed(1), sssOk, foreign, tools });
  console.log(`\n▸ ${v.label}  exit ${r.status} · ${rows.at(-1).s}s`);
  console.log(`  sss 호출: ${sssOk ? '✅' : '❌'} · 전역 서버 호출: ${foreign.join(', ') || '없음'}`);
  console.log(`  자기보고 도구 ${tools.length}개: ${tools.join(', ')}`);
  if (r.status !== 0) console.log(`  stderr: ${(r.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`);
}

console.log('\n' + '─'.repeat(60));
console.log('변형 | sss 도구 | 전역 서버 유입 | 노출 도구 수');
for (const x of rows) console.log(`${x.label} | ${x.sssOk ? '✅' : '❌'} | ${x.foreign.length ? '⚠️ ' + x.foreign.join(',') : '없음'} | ${x.tools.length}`);
