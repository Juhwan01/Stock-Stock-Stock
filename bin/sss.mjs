#!/usr/bin/env node
/**
 * sss — 투자 리서치 에이전트 실행기
 *
 *   sss [codex 옵션…]          대화 — 작업 디렉터리 wiki/ 에서 codex 를 띄운다
 *   sss exec [옵션…] "<지시>"   비대화 1회 실행 (codex exec) — 브리핑·자동화용
 *        --auto-approve-writes  판단 기록 도구를 승인 없이 허용 (테스트용 — 기본은 exec 에서 거부)
 *   sss init                    wiki/ 초기화·복구 (pages/, briefings/, proposals/, AGENTS.md 링크, 별도 git 저장소)
 *   sss doctor                  전제·격리 점검 (모델 호출 없음)
 *   sss briefing [옵션…]         아침 브리핑 — 코드가 새 공시를 모으고, 모델이 분류·해석해 wiki/briefings/<날짜>.md 를 쓴다
 *        --date YYYY-MM-DD  --since YYYY-MM-DD  --model <모델>  --no-llm(원자료만)  --dry-run(수집만)
 *   sss schedule install [--time 07:30] | uninstall | status   평일 아침 브리핑을 launchd 에 등록·해제
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
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { readPortfolio, universe } from '../mcp/lib/portfolio.mjs';
import { listProposals } from '../mcp/lib/proposals.mjs';
import { briefingPath, nextBriefingPath, nextLastDate, collectUpdates, decisionContext, produceBriefing, readState, renderPrompt, sinceFor, writeInbox, writeState } from '../mcp/lib/briefing.mjs';
import { createDart } from '../mcp/lib/dart.mjs';
import { recentFilings } from '../mcp/lib/edgar.mjs';
import { createWiki } from '../mcp/lib/wiki.mjs';
import { kstDate, kstStamp, readRegular, writeAtomic } from '../mcp/lib/store.mjs';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WIKI = resolve(process.env.SSS_WIKI_DIR ?? join(REPO, 'wiki'));
const SERVER = join(REPO, 'mcp', 'server.mjs');
const AGENTS_SRC = join(REPO, 'agent', 'AGENTS.md');
// 데이터 키 파일. 테스트는 다른 경로를 넣어 실제 키·네트워크 없이 돈다
const ENV_FILE = process.env.SSS_ENV_FILE ?? join(REPO, '.env');

export const DISABLED_FEATURES = [
  'apps', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'multi_agent',
  'plugins', 'remote_plugin', 'tool_suggest', 'skill_search', 'skill_mcp_dependency_install', 'goals', 'in_app_browser',
];
/** 위키 정본(판단·보유·관심 종목)을 쓰는 도구 — 대화형에서는 사용자가 인자를 보고 승인해야 실행된다 */
export const WRITE_TOOLS = ['decision_record', 'decision_update', 'watchlist_update', 'holdings_update', 'proposal_resolve'];

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

/** sandbox: 대화·일반 exec 는 workspace-write(위키 안 쓰기), 아침 브리핑은 read-only — 외부 공시 본문을 읽는 무인 실행이라 */
export function isolationArgs({ wiki = WIKI, servers = [], mode = 'chat', autoApproveWrites = false, sandbox = 'workspace-write' } = {}) {
  const writeApproval = mode === 'exec' && autoApproveWrites ? 'approve' : 'prompt';
  return [
    '-C', wiki,
    '-s', sandbox,
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
    // 서버가 자동 실행인지 안다 — 사용자 결정을 대신하는 도구(proposal_resolve)를 exec 에서 거부한다
    '-c', `mcp_servers.sss.env.SSS_MODE=${tomlStr(mode)}`,
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

/** 무결성·격리 점검을 통과한 codex 인자. 통과하지 못하면 던진다 — 띄우지 않는다 */
function codexArgs(mode, { autoApproveWrites = false, sandbox } = {}) {
  const problems = integrityProblems();
  if (problems.length) throw new Error(problems.map((p) => `✖ ${p}`).join('\n'));
  const args = isolationArgs({ servers: listMcpServers(), mode, autoApproveWrites, sandbox });
  checkIsolation(args);
  return args;
}

function launch(mode, rest) {
  const fail = (msg) => {
    console.error(msg);
    process.exit(2);
  };
  // 프로필은 별도 설정 파일의 MCP 서버를 섞는다 — 격리 점검 밖이라 받지 않는다
  if (rest.some((a) => a === '-p' || a === '--profile' || a.startsWith('--profile='))) fail('sss 는 --profile 을 받지 않는다 (격리 점검 밖의 설정이 섞인다)');

  const autoApproveWrites = mode === 'exec' && rest.includes('--auto-approve-writes');
  const userArgs = rest.filter((a) => a !== '--auto-approve-writes');
  let args;
  try {
    args = codexArgs(mode, { autoApproveWrites });
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
  for (const d of ['pages', 'briefings', 'proposals']) mkdirSync(join(WIKI, d), { recursive: true });
  say('pages/ · briefings/ · proposals/ 준비');
  // 브리핑 원자료·상태는 매일 바뀌는 실행 산출물이라 위키 이력에 남기지 않는다
  if (!lexists(join(WIKI, '.gitignore'))) {
    writeFileSync(join(WIKI, '.gitignore'), '# 브리핑 원자료·상태 — 매일 바뀌는 실행 산출물\nbriefings/.inbox-*.json\nbriefings/.state.json\n*.tmp-*\n');
    say('.gitignore 생성 (브리핑 원자료·상태 제외)');
  }

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
    git('add', 'AGENTS.md', '.gitignore');
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
    env = parseEnv(readFileSync(ENV_FILE, 'utf8'));
  } catch {}
  const key = (k, what) => add(!!env[k], `.env ${k}`, env[k] ? '설정됨' : `없음 — ${what}`, false);
  key('DART_API_KEY', '한국 공시(DART) 도구 비활성 · https://opendart.fss.or.kr');
  key('DATA_GO_KR_KEY', 'price_history 비활성 · https://www.data.go.kr/data/15094808/openapi.do');
  key('EDGAR_UA', 'SEC 는 연락처가 담긴 User-Agent 를 요구한다, 예: EDGAR_UA="sss 이름 you@example.com"');
  key('SSS_BRIEFING_MODEL', '브리핑이 Codex 기본 모델로 돈다 — 구독 한도를 아끼려면 경량 모델 이름을 넣는다');
  const scheduled = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' }).status === 0;
  add(scheduled, '평일 아침 브리핑 예약 (launchd)', scheduled ? '등록됨' : 'node bin/sss.mjs schedule install', false);
  add(false, '알려진 한계', '샌드박스는 디스크 읽기를 막지 않는다 — 에이전트 셸이 .env 를 읽을 수 있고 AGENTS.md 규칙이 방어선', false);

  for (const r of rows) console.log(`${r.ok ? '✅' : r.required ? '❌' : '⚪'} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`);
  if (rows.some((r) => r.required && !r.ok)) process.exitCode = 1;
}

// ── 아침 브리핑 ─────────────────────────────────────────────────
const BRIEFING_PROMPT = join(REPO, 'agent', 'BRIEFING.md');
const BRIEFING_LOG = join(REPO, 'var', 'briefing.log');
const BRIEFING_TIMEOUT_MS = 20 * 60e3;

const readDotEnv = () => {
  try {
    return parseEnv(readFileSync(ENV_FILE, 'utf8'));
  } catch {
    return {};
  }
};

/** --name value 또는 --name=value */
const option = (rest, name) => {
  const i = rest.indexOf(`--${name}`);
  if (i >= 0) return rest[i + 1];
  return rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
};

function notify(title, message) {
  if (process.platform !== 'darwin' || process.env.SSS_NO_NOTIFY === '1') return;
  // JSON 문자열 표기는 AppleScript 문자열 이스케이프(\" \\)와 호환된다
  spawnSync('osascript', ['-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`], { stdio: 'ignore' });
}

function runCodex(argv, env) {
  return new Promise((done) => {
    const child = spawn('codex', argv, { stdio: 'inherit', env: childEnv(env) });
    const timer = setTimeout(() => child.kill('SIGTERM'), BRIEFING_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      console.error(e.code === 'ENOENT' ? 'codex 가 없습니다 → npm i -g @openai/codex && codex login' : e.message);
      done(127);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      done(signal ? 124 : code ?? 1);
    });
  });
}

/**
 * 1) 코드가 보유·관심 종목의 새 공시를 모아 원자료(inbox)로 둔다 — 한도를 쓰지 않고 빠짐없이
 * 2) 새 항목이 있을 때만 codex exec 가 분류·해석한다. 읽기 전용 샌드박스라 파일을 쓰지 못하고, 브리핑은 최종 답으로 받는다 —
 *    무인 실행이 외부 공시 본문을 읽으므로 거기 심긴 지시가 위키(보유 원장·페이지·상태)를 고치지 못하게 한다 (코드 리뷰)
 * 3) 실행기가 답을 검증해 쓴다: 빠진 항목은 원자료로 채우고, 실패하면 원자료만으로 쓴다 — 어느 경우든 파일은 남는다
 */
async function briefing(rest) {
  const baseEnv = { ...process.env };
  const log = (s) => console.log(`[briefing ${kstStamp()}] ${s}`);
  const date = option(rest, 'date') ?? kstDate();
  const sinceOpt = option(rest, 'since');
  for (const [k, v] of [['date', date], ['since', sinceOpt]]) {
    if (v != null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--${k} 는 YYYY-MM-DD: ${v}`);
  }
  // 미래 날짜는 마지막 브리핑 날짜로 남아 이후 수집 범위를 망가뜨린다 (코드 리뷰 재현)
  if (date > kstDate()) throw new Error(`--date 가 오늘(${kstDate()})보다 늦다: ${date}`);
  const problems = integrityProblems();
  if (problems.length) throw new Error(problems.map((p) => `✖ ${p}`).join('\n'));

  const env = readDotEnv();
  const uni = universe(readPortfolio(WIKI));
  const state = readState(WIKI);
  const since = sinceFor(state, date, sinceOpt);

  const dart = createDart({ key: () => env.DART_API_KEY, cacheFile: join(REPO, 'var', 'dart-corps.json') });
  // edgar 모듈은 User-Agent 를 process.env 에서 읽는다. 연락처라 비밀은 아니지만 codex 에는 baseEnv 를 넘긴다
  if (env.EDGAR_UA && !process.env.EDGAR_UA) process.env.EDGAR_UA = env.EDGAR_UA;
  const { items, failures } = await collectUpdates({ universe: uni, since, until: date, seen: state.seen, dart, edgar: { recentFilings } });
  log(`수집 ${since}~${date}: 대상 ${uni.length} · 새 항목 ${items.length} · 실패 ${failures.length}`);
  for (const f of failures) log(`  수집 실패 ${f.scope}: ${f.error}`);

  if (rest.includes('--dry-run')) {
    console.log(JSON.stringify({ since, items: items.map((i) => `${i.name} · ${i.date} · ${i.title}`), failures }, null, 2));
    return;
  }
  const saveState = () => writeState(WIKI, { ...state, last_run: new Date().toISOString(), last_date: nextLastDate(state, date) }, { today: date });
  const first = nextBriefingPath(WIKI, date);
  if (first !== briefingPath(WIKI, date) && !items.length) {
    // 같은 날 다시 돌았는데 새 것이 없으면 아침 브리핑과 그 원자료를 그대로 둔다
    saveState();
    log('새 항목 없음 — 오늘 브리핑이 이미 있어 새로 쓰지 않는다');
    return;
  }

  const run = basename(first, '.md'); // 2026-09-28 또는 같은 날 두 번째면 2026-09-28-2
  const { db } = createWiki(join(WIKI, 'pages'), { root: WIKI }).get();
  const pending = listProposals(WIKI, { status: 'pending', limit: 5 });
  const inbox = {
    run,
    date,
    since,
    until: date,
    generated_at: kstStamp(),
    universe: uni,
    items,
    failures,
    open_decisions: decisionContext(db, items),
    pending_proposals: { count: pending.total, oldest: pending.proposals.map((p) => ({ id: p.id, title: p.title, age_days: p.age_days })) },
    notes: ['시세는 싣지 않는다 — 공식 일별 시세는 T+1 13시라 아침엔 이틀 전 값이고, 실시간은 증권사 연결(M4) 후'],
  };
  writeInbox(WIKI, inbox);

  let reason = null;
  if (!uni.length) reason = '보유·관심 종목이 없다 — sss 대화에서 "관심종목 추가해줘"로 등록하면 다음 브리핑부터 모은다';
  else if (rest.includes('--no-llm')) reason = '--no-llm — 모델 호출 없이 원자료만';
  else if (!items.length) reason = '새 항목 없음 — 모델 호출을 생략했다 (구독 한도 절약)';

  const runModel = async () => {
    const model = option(rest, 'model') ?? env.SSS_BRIEFING_MODEL;
    const prompt = renderPrompt(readFileSync(BRIEFING_PROMPT, 'utf8'), { date, since, run, generated_at: inbox.generated_at });
    // 최종 답은 위키 밖(var/)으로 받는다 — 읽기 전용 샌드박스의 에이전트는 여기 닿지 못한다
    const answer = join(REPO, 'var', `briefing-${run}-${process.pid}.md`);
    mkdirSync(dirname(answer), { recursive: true });
    try {
      const code = await runCodex(['exec', ...codexArgs('exec', { sandbox: 'read-only' }), '-o', answer, ...(model ? ['-m', model] : []), prompt], baseEnv);
      return { code, text: readRegular(answer) };
    } finally {
      rmSync(answer, { force: true });
    }
  };
  const result = await produceBriefing({ inbox, reason, runModel });

  // 경로는 모델 실행이 끝난 뒤 다시 잡는다 — 실행 중에 briefings/ 가 바뀌었으면 여기서 거부된다
  const out = nextBriefingPath(WIKI, date);
  writeAtomic(out, result.markdown);
  for (const i of items) state.seen[i.id] = date;
  saveState();

  const counts = result.markdown.match(/^counts:\s*\{([^}\n]*)\}/m)?.[1];
  const n = (k) => counts?.match(new RegExp(`${k}:\\s*(\\d+)`))?.[1];
  const summary = result.fallback
    ? `원자료만 · 새 항목 ${items.length}건`
    : `${n('proposals') != null ? `제안 ${n('proposals')} · 참고 ${n('notes') ?? '?'} · 무시 ${n('ignored') ?? '?'}` : `새 항목 ${items.length}건`}${result.missing ? ` · 누락 ${result.missing}건 원자료로 보충` : ''}`;
  log(`완료 → ${out} (${summary})`);
  notify('sss 아침 브리핑', `${date} · ${summary}`);
}

// ── 예약 (launchd) ─────────────────────────────────────────────
export const LABEL = 'com.stock-stock-stock.briefing';
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 평일(월~금) 지정 시각에 sss briefing 을 실행하는 LaunchAgent. 잠자기 중 놓친 실행은 깨어날 때 한 번 돈다 */
export function plistXml({ node, script, wiki, path, time, log, cwd }) {
  const [hour, minute] = time.split(':').map(Number);
  const days = [1, 2, 3, 4, 5]
    .map((d) => `      <dict><key>Weekday</key><integer>${d}</integer><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(script)}</string>
    <string>briefing</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path)}</string>
    <key>SSS_WIKI_DIR</key><string>${xml(wiki)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(cwd)}</string>
  <key>StartCalendarInterval</key>
  <array>
${days}
  </array>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

function schedule(rest) {
  const sub = rest[0] ?? 'status';
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  const launchctl = (...a) => spawnSync('launchctl', a, { encoding: 'utf8' });

  if (sub === 'install') {
    const time = option(rest, 'time') ?? '07:30';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`--time 은 HH:MM: ${time}`);
    const problems = integrityProblems();
    if (problems.length) throw new Error(`위키부터 준비한다: ${problems.join(' / ')}`);
    const which = spawnSync('which', ['codex'], { encoding: 'utf8' });
    if (which.status !== 0) throw new Error('codex 가 PATH 에 없다 → npm i -g @openai/codex');
    // launchd 는 PATH 가 빈약하다 — codex(와 그 node) 위치를 설치 시점에 고정한다
    const path = [...new Set([dirname(which.stdout.trim()), dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
    mkdirSync(dirname(BRIEFING_LOG), { recursive: true });
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, plistXml({ node: process.execPath, script: fileURLToPath(import.meta.url), wiki: WIKI, path, time, log: BRIEFING_LOG, cwd: REPO }));
    launchctl('bootout', `${domain}/${LABEL}`); // 이전 등록이 있으면 내린다 — 없으면 실패해도 무방
    const b = launchctl('bootstrap', domain, plist);
    if (b.status !== 0) throw new Error(`launchctl bootstrap 실패: ${(b.stderr || b.stdout).trim()}`);
    console.log(`✅ 평일 ${time} 아침 브리핑 등록 — ${plist}\n   로그: ${BRIEFING_LOG}\n   지금 한 번 돌려 보기: node bin/sss.mjs briefing`);
  } else if (sub === 'uninstall') {
    launchctl('bootout', `${domain}/${LABEL}`);
    rmSync(plist, { force: true });
    console.log('✅ 아침 브리핑 예약 해제');
  } else if (sub === 'status') {
    const loaded = launchctl('print', `${domain}/${LABEL}`).status === 0;
    console.log(`${loaded ? '✅ 등록됨' : '⚪ 등록 안 됨'} — ${existsSync(plist) ? plist : 'plist 없음'}`);
    if (existsSync(BRIEFING_LOG)) {
      console.log('최근 로그:');
      console.log(readFileSync(BRIEFING_LOG, 'utf8').trim().split('\n').slice(-5).map((l) => `  ${l}`).join('\n'));
    }
  } else {
    throw new Error(`알 수 없는 schedule 명령: ${sub} (install | uninstall | status)`);
  }
}

const orExit = (fn) => Promise.resolve().then(fn).catch((e) => {
  console.error(e.message);
  process.exit(1);
});

/** 예약 실행에서 브리핑 자체가 실패해도(포트폴리오 형식 오류 등) 아침에 이유를 볼 수 있게 남긴다 */
async function briefingOrReport(rest) {
  try {
    await briefing(rest);
  } catch (e) {
    const date = option(rest, 'date') ?? kstDate();
    // 미래 날짜로 실패 보고를 남기면 그날 아침 브리핑이 -2.md 로 밀린다
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= kstDate();
    if (valid && !integrityProblems().length) {
      try {
        const out = briefingPath(WIKI, date);
        if (!lexists(out)) writeAtomic(out, `---\ndate: ${date}\nfallback: true\nerror: true\n---\n\n# ${date} 아침 브리핑 — 실패\n\n> ${e.message.replace(/\n/g, ' ')}\n\n고친 뒤 \`node bin/sss.mjs briefing\` 으로 다시 돌린다. 로그: var/briefing.log\n`);
      } catch {}
    }
    // 규칙 파일 변조 같은 무결성 실패가 가장 알아야 할 실패다 — 파일을 못 남겨도 알림은 보낸다
    if (valid) notify('sss 아침 브리핑 실패', e.message.slice(0, 120));
    throw e;
  }
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'init') init();
  else if (cmd === 'doctor') doctor();
  else if (cmd === 'briefing') orExit(() => briefingOrReport(rest));
  else if (cmd === 'schedule') orExit(() => schedule(rest));
  else if (cmd === 'exec') launch('exec', rest);
  else if (cmd === '-h' || cmd === '--help' || cmd === 'help') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1].replace(/^ \* ?/gm, ''));
  } else launch('chat', cmd ? [cmd, ...rest] : []);
}
