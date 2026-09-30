/**
 * macOS launchd 등록 — CLI(sss schedule · sss watch)와 대화 도구(briefing_schedule · watch_control)가 같이 쓴다
 *  - 아침 브리핑: 평일 지정 시각에 한 번
 *  - 상시 감시: 로그인하면 뜨고, 죽으면 다시 뜬다 (KeepAlive)
 *
 * 테스트는 dir·launchctl 을 바꿔 넣어 실제 launchd 를 건드리지 않는다
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LABEL = 'com.stock-stock-stock.briefing';
export const WATCH_LABEL = 'com.stock-stock-stock.watch';
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 테스트는 SSS_LAUNCHD_DIR·SSS_LAUNCHCTL 이나 opts 로 바꿔 넣는다 */
const target = (opts = {}) => ({
  dir: process.env.SSS_LAUNCHD_DIR ?? join(homedir(), 'Library', 'LaunchAgents'),
  // 절대 경로 — MCP 서버의 PATH 에 상대 경로가 섞여도 위키에 심은 실행 파일이 불리지 않게
  launchctl: process.env.SSS_LAUNCHCTL ?? '/bin/launchctl',
  ...opts,
});
const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8' });
const domain = () => `gui/${process.getuid()}`;

/** 평일(월~금) 지정 시각(이 맥의 현지 시각)에 sss briefing 을 실행하는 LaunchAgent. 잠자기 중 놓친 실행은 깨어날 때 한 번 돈다 */
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

/** launchd 는 PATH 가 빈약하다 — codex(와 그 node) 위치를 등록 시점에 고정한다 */
function launchPath() {
  const which = spawnSync('/usr/bin/which', ['codex'], { encoding: 'utf8' });
  const codexDir = which.status === 0 ? dirname(which.stdout.trim()) : null;
  // npm 전역 설치면 codex 는 node 옆에 있다 — MCP 서버처럼 PATH 가 줄어든 환경에서도 찾는다
  const nodeDir = dirname(process.execPath);
  if (!codexDir && !existsSync(join(nodeDir, 'codex'))) throw new Error('codex 를 찾지 못했다 → npm i -g @openai/codex');
  return [...new Set([codexDir, nodeDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].filter(Boolean))].join(':');
}

/** plist 를 쓰고 (이전 등록을 내린 뒤) 올린다. 실패하면 plist 를 지운다 — 등록이 남아 있다고 믿지 않게 */
function bootstrap(label, xmlText, { dir, launchctl }, what) {
  const plist = join(dir, `${label}.plist`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(plist, xmlText);
  run(launchctl, ['bootout', `${domain()}/${label}`]); // 이전 등록이 있으면 내린다 — 없으면 실패해도 무방
  // 상주 작업은 내린 직후 아직 끝나는 중일 수 있다(최대 20초) — 그동안 bootstrap 은 5(I/O 오류)로 실패한다. 잠깐씩 다시 해 본다
  let b = run(launchctl, ['bootstrap', domain(), plist]);
  for (let i = 0; i < 20 && b.status !== 0 && /^5:|Input\/output error/m.test(`${b.stderr}${b.stdout}`); i++) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
    b = run(launchctl, ['bootstrap', domain(), plist]);
  }
  if (b.status !== 0) {
    rmSync(plist, { force: true });
    throw new Error(`launchctl bootstrap 실패 — 지금은 ${what} 없다 (이전 것도 해제됨): ${(b.stderr || b.stdout || b.error?.message || '').trim()}`);
  }
  return plist;
}

function bootout(label, { dir, launchctl }) {
  const plist = join(dir, `${label}.plist`);
  const had = existsSync(plist);
  run(launchctl, ['bootout', `${domain()}/${label}`]);
  rmSync(plist, { force: true });
  return had;
}

/** 등록(이미 있으면 시각을 바꿔 다시 등록) */
export function installSchedule({ time = '07:30', wiki, script, repo, log }, opts) {
  const t = target(opts);
  if (!TIME.test(time)) throw new Error(`시각은 HH:MM (00:00~23:59): ${time}`);
  mkdirSync(dirname(log), { recursive: true });
  const plist = bootstrap(LABEL, plistXml({ node: process.execPath, script, wiki, path: launchPath(), time, log, cwd: repo }), t, '예약이');
  return { registered: true, time, weekdays: '월~금', plist, log };
}

export function uninstallSchedule(opts) {
  return { registered: false, removed: bootout(LABEL, target(opts)) };
}

/**
 * 상시 감시 LaunchAgent — 로그인 때 뜨고(RunAtLoad), 죽으면 30초 뒤 다시 뜬다(KeepAlive · ThrottleInterval).
 * 잠자기 막기는 감시가 caffeinate 를 직접 붙인다 — 설정을 바꾸면 다시 등록하지 않아도 다음 틱에 반영된다
 */
export function watchPlistXml({ node, script, wiki, path, log, cwd }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${WATCH_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(script)}</string>
    <string>watch</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(path)}</string>
    <key>SSS_WIKI_DIR</key><string>${xml(wiki)}</string>
  </dict>
  <key>WorkingDirectory</key><string>${xml(cwd)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** log 는 launchd 가 받는 표준 출력(비정상 종료 흔적) — 감시 자체의 로그는 var/watch.log 에 감시가 쓴다 */
export function installWatch({ wiki, script, repo, log }, opts) {
  const t = target(opts);
  mkdirSync(dirname(log), { recursive: true });
  const plist = bootstrap(WATCH_LABEL, watchPlistXml({ node: process.execPath, script, wiki, path: launchPath(), log, cwd: repo }), t, '감시가');
  return { registered: true, plist };
}

export function uninstallWatch(opts) {
  return { registered: false, removed: bootout(WATCH_LABEL, target(opts)) };
}

export function watchAgentStatus(opts) {
  const { dir, launchctl } = target(opts);
  const plist = join(dir, `${WATCH_LABEL}.plist`);
  return { registered: run(launchctl, ['print', `${domain()}/${WATCH_LABEL}`]).status === 0, plist: existsSync(plist) ? plist : null };
}

/** { registered, time, plist } — time 은 plist 에서 읽는다 */
export function scheduleStatus(opts) {
  const { dir, launchctl } = target(opts);
  const plist = join(dir, `${LABEL}.plist`);
  const loaded = run(launchctl, ['print', `${domain()}/${LABEL}`]).status === 0;
  let time = null;
  if (existsSync(plist)) {
    const m = readFileSync(plist, 'utf8').match(/<key>Hour<\/key><integer>(\d+)<\/integer><key>Minute<\/key><integer>(\d+)<\/integer>/);
    if (m) time = `${m[1].padStart(2, '0')}:${m[2].padStart(2, '0')}`;
  }
  return { registered: loaded, time, weekdays: '월~금', plist: existsSync(plist) ? plist : null };
}
