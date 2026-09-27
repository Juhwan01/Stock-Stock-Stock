/**
 * 평일 아침 브리핑 예약 (macOS launchd) — CLI(sss schedule)와 대화 도구(briefing_schedule)가 같이 쓴다
 *
 * 테스트는 dir·launchctl 을 바꿔 넣어 실제 launchd 를 건드리지 않는다
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LABEL = 'com.stock-stock-stock.briefing';
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

/** 등록(이미 있으면 시각을 바꿔 다시 등록) */
export function installSchedule({ time = '07:30', wiki, script, repo, log }, opts) {
  const { dir, launchctl } = target(opts);
  if (!TIME.test(time)) throw new Error(`시각은 HH:MM (00:00~23:59): ${time}`);
  const plist = join(dir, `${LABEL}.plist`);
  mkdirSync(dirname(log), { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(plist, plistXml({ node: process.execPath, script, wiki, path: launchPath(), time, log, cwd: repo }));
  run(launchctl, ['bootout', `${domain()}/${LABEL}`]); // 이전 등록이 있으면 내린다 — 없으면 실패해도 무방
  const b = run(launchctl, ['bootstrap', domain(), plist]);
  if (b.status !== 0) {
    // 이전 등록은 이미 내렸다 — 예약이 남아 있다고 믿지 않게 분명히 말한다
    rmSync(plist, { force: true });
    throw new Error(`launchctl bootstrap 실패 — 지금은 예약이 없다 (이전 예약도 해제됨): ${(b.stderr || b.stdout || b.error?.message || '').trim()}`);
  }
  return { registered: true, time, weekdays: '월~금', plist, log };
}

export function uninstallSchedule(opts) {
  const { dir, launchctl } = target(opts);
  const plist = join(dir, `${LABEL}.plist`);
  const had = existsSync(plist);
  run(launchctl, ['bootout', `${domain()}/${LABEL}`]);
  rmSync(plist, { force: true });
  return { registered: false, removed: had };
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
