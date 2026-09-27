#!/usr/bin/env node
/**
 * sss — 투자 리서치 에이전트 실행기
 *
 *   sss [codex 옵션…]          대화 — 작업 디렉터리 wiki/ 에서 codex 를 띄운다
 *   sss exec [옵션…] "<지시>"   비대화 1회 실행 (codex exec) — 브리핑·자동화용
 *        --auto-approve-writes  판단 기록 도구를 승인 없이 허용 (테스트용 — 기본은 exec 에서 거부)
 *   sss init                    wiki/ 초기화·복구 (pages/, briefings/, AGENTS.md 링크, 별도 git 저장소)
 *   sss doctor                  전제·격리 점검 (모델 호출 없음)
 *
 * 격리 레시피 (docs/SPIKE-RESULTS.md §10 — 기본 85개 도구 → 24개):
 *  - 작업 디렉터리 = wiki/ → 샌드박스 쓰기 범위가 위키(와 시스템 임시 폴더)뿐이다. 에이전트는 mcp/·bin/ 코드를 고칠 수 없다
 *  - Codex 가 실제로 읽는 MCP 서버 목록(`codex mcp list --json`)을 받아 sss 외에는 이름별로 끈다.
 *    TOML 을 직접 파싱하지 않는다 — 정규식이 놓친 표기의 서버가 켜진 채 남는다 (코드 리뷰 재현)
 *  - 띄우기 직전에 같은 설정으로 목록을 다시 받아 sss 만 켜졌는지 확인한다. 아니면 띄우지 않는다
 *  - ChatGPT 계정 커넥터(apps) 등 도구를 노출하는 기능 13개 + 웹검색을 끈다
 *  - 로그인 방식을 ChatGPT 로 고정하고, 샌드박스 네트워크·추가 쓰기 경로를 사용자 설정과 무관하게 닫는다
 *  - 판단 기록 도구는 대화형에서 사용자 승인(prompt)을 거친다. user_confirmed 는 모델이 채우는 값이라 강제가 아니다
 *  - 규칙 파일(AGENTS.md 링크)이 바뀌었거나 AGENTS.override.md 가 있으면 띄우지 않는다 — 에이전트가 자기 규칙을 고친 흔적
 *  - CODEX_API_KEY 를 자식 환경에서 지운다 — 있으면 exec 가 조용히 API 과금으로 넘어간다
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WIKI = resolve(process.env.SSS_WIKI_DIR ?? join(REPO, 'wiki'));
const SERVER = join(REPO, 'mcp', 'server.mjs');
const AGENTS_SRC = join(REPO, 'agent', 'AGENTS.md');

export const DISABLED_FEATURES = [
  'apps', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'multi_agent',
  'plugins', 'remote_plugin', 'tool_suggest', 'skill_search', 'skill_mcp_dependency_install', 'goals', 'in_app_browser',
];
/** 위키에 판단을 쓰는 도구 — 대화형에서는 사용자가 인자를 보고 승인해야 실행된다 */
export const WRITE_TOOLS = ['decision_record', 'decision_update'];

export function childEnv(env = process.env) {
  const out = { ...env };
  delete out.CODEX_API_KEY;
  return out;
}

const lexists = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Codex 가 실제로 읽는 MCP 서버 목록 [{ name, enabled }]. extra 는 같이 적용할 -c 인자 */
export function listMcpServers(extra = []) {
  const r = spawnSync('codex', ['mcp', 'list', '--json', ...extra], {
    cwd: existsSync(WIKI) ? WIKI : REPO, encoding: 'utf8', env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.error) throw new Error(r.error.code === 'ENOENT' ? 'codex 가 없습니다 → npm i -g @openai/codex && codex login' : r.error.message);
  if (r.status !== 0) throw new Error(`codex mcp list 실패: ${(r.stderr || r.stdout).trim().split('\n').pop()}`);
  return JSON.parse(r.stdout).map((s) => ({ name: s.name, enabled: !!s.enabled }));
}

/** sss 외에 켜진 서버를 끄는 -c 인자. -c 키는 점마다 쪼개지므로 점·공백이 든 이름은 끌 수 없다 — 거부한다 */
export function disableArgs(servers) {
  const out = [];
  for (const s of servers) {
    if (s.name === 'sss' || !s.enabled) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(s.name)) {
      throw new Error(`-c 로 끌 수 없는 MCP 서버 이름: "${s.name}" (점·공백 포함) — ~/.codex/config.toml 에서 이름을 바꾸거나 enabled = false 로 둔다`);
    }
    out.push('-c', `mcp_servers.${s.name}.enabled=false`);
  }
  return out;
}

// -c 값은 TOML 로 파싱된다. JSON 문자열 표기는 TOML 기본 문자열과 호환된다
const tomlStr = (s) => JSON.stringify(s);

export function isolationArgs({ wiki = WIKI, servers = [], mode = 'chat', autoApproveWrites = false } = {}) {
  const writeApproval = mode === 'exec' && autoApproveWrites ? 'approve' : 'prompt';
  return [
    '-C', wiki,
    '-s', 'workspace-write',
    ...disableArgs(servers),
    ...DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
    '-c', 'web_search="disabled"',
    // 사용자 설정이 과금·샌드박스를 넓히지 못하게 고정한다
    '-c', 'forced_login_method="chatgpt"',
    '-c', 'sandbox_workspace_write.network_access=false',
    '-c', 'sandbox_workspace_write.writable_roots=[]',
    '-c', 'project_doc_fallback_filenames=[]',
    // sss 서버 주입. 전역 설정에 같은 이름이 있어도 켜진 상태·명령은 여기 값이 이긴다
    '-c', 'mcp_servers.sss.enabled=true',
    // launchd 처럼 PATH 가 빈약한 환경에서도 뜨도록 node 를 절대 경로로 넘긴다
    '-c', `mcp_servers.sss.command=${tomlStr(process.execPath)}`,
    '-c', `mcp_servers.sss.args=[${tomlStr(SERVER)}]`,
    '-c', `mcp_servers.sss.env.SSS_WIKI_DIR=${tomlStr(wiki)}`,
    '-c', 'mcp_servers.sss.required=true',
    '-c', 'mcp_servers.sss.startup_timeout_sec=20',
    // 조회 도구는 자동 승인 — 없으면 exec(승인 정책 never)에서 호출이 거부된다
    '-c', 'mcp_servers.sss.default_tools_approval_mode="approve"',
    // 쓰기 도구는 대화형이면 사용자 승인, exec 면 기본 거부
    ...WRITE_TOOLS.flatMap((t) => ['-c', `mcp_servers.sss.tools.${t}.approval_mode="${writeApproval}"`]),
  ];
}

/** 격리 인자를 적용한 목록에서 켜진 서버가 sss 하나인지 — 모델 호출 없는 사전 점검 */
export function checkIsolation(args, list = listMcpServers) {
  const cfg = args.flatMap((a, i) => (a === '-c' ? ['-c', args[i + 1]] : []));
  const on = list(cfg).filter((s) => s.enabled).map((s) => s.name);
  if (on.length !== 1 || on[0] !== 'sss') {
    throw new Error(`격리 실패 — 켜진 MCP 서버: ${on.join(', ') || '없음'} (sss 하나여야 한다)`);
  }
}

function linksToAgents(link) {
  try {
    return realpathSync(link) === realpathSync(AGENTS_SRC);
  } catch {
    return false; // 깨진 링크
  }
}

function wikiReady() {
  return existsSync(join(WIKI, '.git')) && existsSync(join(WIKI, 'pages')) && lexists(join(WIKI, 'AGENTS.md'));
}

/** 띄우기 전에 막아야 하는 위키 상태 */
export function integrityProblems(wiki = WIKI) {
  const out = [];
  if (!(existsSync(join(wiki, '.git')) && existsSync(join(wiki, 'pages')) && lexists(join(wiki, 'AGENTS.md')))) {
    return [`위키가 초기화되지 않음: ${wiki} → node bin/sss.mjs init`];
  }
  if (!linksToAgents(join(wiki, 'AGENTS.md'))) {
    out.push('wiki/AGENTS.md 가 agent/AGENTS.md 를 가리키는 링크가 아님 — 규칙이 바뀌었을 수 있다 → node bin/sss.mjs init 으로 복구');
  }
  if (lexists(join(wiki, 'AGENTS.override.md'))) {
    out.push('wiki/AGENTS.override.md 가 있음 — Codex 가 규칙보다 우선해 읽는다 → 내용 확인 후 node bin/sss.mjs init (옆으로 치워 둔다)');
  }
  if (lexists(join(wiki, 'pages')) && lstatSync(join(wiki, 'pages')).isSymbolicLink()) {
    out.push('wiki/pages 가 링크임 — 서버는 쓰기를 거부한다. 실제 디렉터리로 되돌린다');
  }
  return out;
}

function launch(mode, rest) {
  const fail = (msg) => {
    console.error(msg);
    process.exit(2);
  };
  const problems = integrityProblems();
  if (problems.length) fail(problems.map((p) => `✖ ${p}`).join('\n'));
  // 프로필은 별도 설정 파일의 MCP 서버를 섞는다 — 격리 점검 밖이라 받지 않는다
  if (rest.some((a) => a === '-p' || a === '--profile' || a.startsWith('--profile='))) fail('sss 는 --profile 을 받지 않는다 (격리 점검 밖의 설정이 섞인다)');

  const autoApproveWrites = mode === 'exec' && rest.includes('--auto-approve-writes');
  const userArgs = rest.filter((a) => a !== '--auto-approve-writes');
  let args;
  try {
    args = isolationArgs({ servers: listMcpServers(), mode, autoApproveWrites });
    checkIsolation(args);
  } catch (e) {
    fail(e.message);
  }
  const child = spawn('codex', mode === 'exec' ? ['exec', ...args, ...userArgs] : [...args, ...userArgs], {
    stdio: 'inherit', env: childEnv(),
  });
  child.on('error', (e) => fail(e.code === 'ENOENT' ? 'codex 가 없습니다 → npm i -g @openai/codex && codex login' : e.message));
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1));
}

function init() {
  const say = (s) => console.log(`  ${s}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  console.log(`위키 초기화: ${WIKI}`);
  mkdirSync(WIKI, { recursive: true });
  if (lexists(join(WIKI, 'pages')) && lstatSync(join(WIKI, 'pages')).isSymbolicLink()) {
    console.error('✖ wiki/pages 가 링크임 — 데이터를 잃지 않도록 자동으로 고치지 않는다. 링크를 지우고 실제 디렉터리로 옮긴 뒤 다시 실행');
    process.exit(1);
  }
  for (const d of ['pages', 'briefings']) mkdirSync(join(WIKI, d), { recursive: true });
  say('pages/ · briefings/ 준비');

  // 에이전트가 자기 규칙을 바꾼 흔적은 지우지 않고 옆으로 치운다 — 무엇을 바꿨는지 볼 수 있게
  const override = join(WIKI, 'AGENTS.override.md');
  if (lexists(override)) {
    renameSync(override, `${override}.disabled-${stamp}`);
    say(`⚠ AGENTS.override.md 를 AGENTS.override.md.disabled-${stamp} 로 치움`);
  }
  const link = join(WIKI, 'AGENTS.md');
  // 상대 경로는 실제 경로끼리 계산한다 — macOS 의 /var 는 /private/var 링크라 겉경로로 계산하면 링크가 깨진다
  const target = relative(realpathSync(WIKI), realpathSync(AGENTS_SRC));
  let stat = null;
  try {
    stat = lstatSync(link);
  } catch {}
  if (!stat) {
    symlinkSync(target, link);
    say('AGENTS.md → agent/AGENTS.md 링크 생성');
  } else if (linksToAgents(link)) {
    say('AGENTS.md 링크 있음');
  } else if (stat.isSymbolicLink()) {
    unlinkSync(link);
    symlinkSync(target, link);
    say('AGENTS.md 링크가 깨져 있어 다시 만듦');
  } else {
    renameSync(link, `${link}.replaced-${stamp}`);
    symlinkSync(target, link);
    say(`⚠ AGENTS.md 가 일반 파일로 바뀌어 있었음 → AGENTS.md.replaced-${stamp} 로 치우고 링크 복구`);
  }
  if (!linksToAgents(link)) {
    console.error('✖ AGENTS.md 링크 확인 실패');
    process.exitCode = 1;
  }

  // 위키는 코드 레포와 분리된 자체 git 저장소다 — 개인 판단·포지션이 코드와 함께 push 되지 않게
  if (!existsSync(join(WIKI, '.git'))) {
    const git = (...a) => spawnSync('git', a, { cwd: WIKI, encoding: 'utf8' });
    const i = git('init', '-q');
    if (i.error || i.status !== 0) {
      console.error(`✖ git init 실패: ${i.error?.message ?? i.stderr?.trim()}`);
      process.exit(1);
    }
    git('add', 'AGENTS.md');
    const c = git('commit', '-q', '-m', '위키 초기화');
    say(c.status === 0 ? '별도 git 저장소 생성 + 첫 커밋' : `git 저장소 생성 (첫 커밋 실패: ${c.stderr?.trim() || c.error?.message})`);
  } else {
    say('git 저장소 있음');
  }
  console.log('\n다음: node bin/sss.mjs doctor → node bin/sss.mjs (첫 실행 때 Codex 가 이 폴더를 신뢰할지 묻는다)');
}

function doctor() {
  const rows = [];
  const add = (ok, name, detail = '', required = true) => rows.push({ ok, name, detail, required });

  const major = Number(process.versions.node.split('.')[0]);
  add(major >= 24, 'Node 24+ (node:sqlite FTS5 trigram)', process.version);

  const ver = spawnSync('codex', ['--version'], { encoding: 'utf8', env: childEnv() });
  add(!ver.error && ver.status === 0, 'Codex CLI 설치', ver.error ? 'npm i -g @openai/codex' : ver.stdout.trim());

  if (!ver.error) {
    const login = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', env: childEnv() });
    const text = `${login.stdout}${login.stderr}`.trim().split('\n')[0];
    add(login.status === 0 && /chatgpt/i.test(text), 'ChatGPT 계정으로 로그인 (구독 과금 — sss 는 이 방식으로 고정한다)', text || 'codex login');
    const doc = spawnSync('codex', ['doctor'], { encoding: 'utf8', env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    const stored = (k) => doc.stdout?.match(new RegExp(`${k}\\s+(\\S+)`))?.[1];
    add(stored('stored API key') === 'false', 'auth.json 에 API 키 없음', `mode=${stored('stored auth mode')}`);

    try {
      const servers = listMcpServers();
      checkIsolation(isolationArgs({ servers }));
      const off = servers.filter((s) => s.enabled && s.name !== 'sss').map((s) => s.name);
      add(true, '격리 — 실행 시 sss 만 켜짐', off.length ? `끄는 전역 서버: ${off.join(', ')}` : '끌 전역 서버 없음');
    } catch (e) {
      add(false, '격리 — 실행 시 sss 만 켜짐', e.message);
    }
  }
  add(!process.env.CODEX_API_KEY, 'CODEX_API_KEY 미설정', process.env.CODEX_API_KEY ? '셸 프로필에서 제거 — sss 는 지우지만 codex 를 직접 쓸 때 과금된다' : '', false);

  const problems = integrityProblems();
  add(!problems.length, '위키 무결성 (초기화·규칙 링크·override 없음)', problems.join(' / ') || WIKI);

  let env = {};
  try {
    env = parseEnv(readFileSync(join(REPO, '.env'), 'utf8'));
  } catch {}
  const key = (k, what) => add(!!env[k], `.env ${k}`, env[k] ? '설정됨' : `없음 — ${what}`, false);
  key('DART_API_KEY', '한국 공시(DART) 도구 비활성 · https://opendart.fss.or.kr');
  key('DATA_GO_KR_KEY', 'price_history 비활성 · https://www.data.go.kr/data/15094808/openapi.do');
  key('EDGAR_UA', 'SEC 는 연락처가 담긴 User-Agent 를 요구한다, 예: EDGAR_UA="sss 이름 you@example.com"');
  add(false, '알려진 한계', '샌드박스는 디스크 읽기를 막지 않는다 — 에이전트 셸이 .env 를 읽을 수 있고 AGENTS.md 규칙이 방어선', false);

  for (const r of rows) console.log(`${r.ok ? '✅' : r.required ? '❌' : '⚪'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  if (rows.some((r) => r.required && !r.ok)) process.exitCode = 1;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'init') init();
  else if (cmd === 'doctor') doctor();
  else if (cmd === 'exec') launch('exec', rest);
  else if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, ''));
  } else launch('chat', cmd ? [cmd, ...rest] : []);
}
