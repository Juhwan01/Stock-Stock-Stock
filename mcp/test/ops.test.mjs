import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSettings, resolveRoute, routeProblem, routeTable, updateRoute, ROUTES } from '../lib/models.mjs';
import { installSchedule, scheduleStatus, uninstallSchedule, LABEL } from '../lib/schedule.mjs';
import { acquireRunLock, runningBriefing } from '../lib/briefing.mjs';

const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const CATALOG = new Map([
  ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
  ['gpt-6-sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']],
  ['gpt-6-luna', ['low', 'medium', 'high', 'xhigh', 'max']],
]);

// ── 모델 설정 (대화의 model_settings) ─────────────────────────────
test('모델 설정 — 목록에 있는 값만 저장하고, 바꾼 용도만 달라진다', () => {
  const file = join(tmp('sss-models-'), 'settings.json');
  const out = updateRoute({ route: 'briefing', model: 'gpt-6-sol' }, { file, catalog: CATALOG });
  assert.deepEqual([out.model, out.effort, out.source], ['gpt-6-sol', ROUTES.briefing.effort, 'settings']);
  assert.deepEqual(readSettings(file), { models: { briefing: { model: 'gpt-6-sol', effort: ROUTES.briefing.effort } } });
  assert.equal(resolveRoute('chat', { env: {}, settings: readSettings(file) }).source, 'default');

  updateRoute({ route: 'briefing', effort: 'high' }, { file, catalog: CATALOG });
  assert.deepEqual(readSettings(file).models.briefing, { model: 'gpt-6-sol', effort: 'high' }, '강도만 바꾸면 저장한 모델은 남는다');
  updateRoute({ route: 'briefing', reset: true }, { file, catalog: CATALOG });
  assert.deepEqual(readSettings(file), { models: {} });
});

test('모델 설정 — 없는 모델·지원하지 않는 강도·목록을 못 받은 경우는 저장하지 않는다 (무인 브리핑이 원자료만 남게 된다)', () => {
  const file = join(tmp('sss-models2-'), 'settings.json');
  assert.throws(() => updateRoute({ route: 'briefing', model: 'gpt-9' }, { file, catalog: CATALOG }), /목록에 없는 모델/);
  assert.throws(() => updateRoute({ route: 'briefing', model: 'gpt-6-luna', effort: 'ultra' }, { file, catalog: CATALOG }), /지원하지 않음/);
  assert.throws(() => updateRoute({ route: 'briefing', model: 'gpt-6-sol' }, { file, catalog: null }), /목록을 받지 못해/);
  assert.throws(() => updateRoute({ route: 'nope', model: 'gpt-6-sol' }, { file, catalog: CATALOG }), /알 수 없는 용도/);
  assert.throws(() => updateRoute({ route: 'chat' }, { file, catalog: CATALOG }), /하나는 준다/);
  assert.ok(!existsSync(file));
});

test('모델 표 — 기본값이 모두 목록에 있고, 강도 목록을 못 읽으면 강도는 따지지 않는다', () => {
  assert.ok(routeTable({ env: {}, settings: {}, catalog: CATALOG }).every((r) => r.problem === null));
  assert.equal(routeProblem({ model: 'x', effort: 'weird' }, new Map([['x', []]])), null);
  assert.ok(!('problem' in routeTable({ env: {}, settings: {} })[0]), '목록을 넘기지 않으면 대조하지 않는다');
});

// ── 예약 (가짜 launchctl — 실제 launchd 를 건드리지 않는다) ─────────
function fakeLaunchd() {
  const dir = tmp('sss-launchd-');
  const calls = join(dir, 'calls.log');
  const bin = join(dir, 'launchctl');
  // print 은 등록돼 있을 때(부트스트랩 뒤)만 성공한다
  writeFileSync(bin, `#!/bin/sh
echo "$@" >> ${JSON.stringify(calls)}
case "$1" in
  bootstrap) touch ${JSON.stringify(join(dir, 'loaded'))} ;;
  bootout) rm -f ${JSON.stringify(join(dir, 'loaded'))} ;;
  print) [ -f ${JSON.stringify(join(dir, 'loaded'))} ] || exit 113 ;;
esac
`);
  chmodSync(bin, 0o755);
  const agents = join(dir, 'LaunchAgents');
  return { opts: { dir: agents, launchctl: bin }, agents, calls: () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : []) };
}

test('예약 — 등록·시각 변경·상태·해제', () => {
  const f = fakeLaunchd();
  const job = { wiki: '/r/wiki', script: '/r/bin/sss.mjs', repo: '/r', log: join(tmp('sss-log-'), 'briefing.log') };
  assert.deepEqual(scheduleStatus(f.opts), { registered: false, time: null, weekdays: '월~금', plist: null });

  const r = installSchedule({ ...job, time: '07:05' }, f.opts);
  assert.equal(r.time, '07:05');
  const plist = join(f.agents, `${LABEL}.plist`);
  assert.match(readFileSync(plist, 'utf8'), /<key>SSS_WIKI_DIR<\/key><string>\/r\/wiki<\/string>/);
  assert.deepEqual(scheduleStatus(f.opts), { registered: true, time: '07:05', weekdays: '월~금', plist });

  installSchedule({ ...job, time: '08:30' }, f.opts);
  assert.equal(scheduleStatus(f.opts).time, '08:30', '다시 등록하면 시각이 바뀐다');
  assert.ok(f.calls().filter((c) => c.startsWith('bootout')).length >= 2, '다시 등록하기 전에 이전 등록을 내린다');

  assert.deepEqual(uninstallSchedule(f.opts), { registered: false, removed: true });
  assert.deepEqual(scheduleStatus(f.opts), { registered: false, time: null, weekdays: '월~금', plist: null });
  assert.deepEqual(readdirSync(f.agents), []);
});

test('예약 — 시각 형식이 틀리면 아무것도 쓰지 않는다', () => {
  const f = fakeLaunchd();
  for (const time of ['7:30', '24:00', '07:60', '0730']) {
    assert.throws(() => installSchedule({ time, wiki: '/w', script: '/s', repo: '/r', log: '/tmp/x.log' }, f.opts), /HH:MM/, time);
  }
  assert.ok(!existsSync(f.agents));
  assert.deepEqual(f.calls(), []);
});

// ── 실행 잠금 ─────────────────────────────────────────────────────
test('실행 잠금 — 같은 위키는 한 번에 하나, 다른 위키는 따로, 풀면 다시 잡힌다', () => {
  const lockDir = tmp('sss-lock-');
  const [a, b] = [tmp('sss-wa-'), tmp('sss-wb-')];
  const release = acquireRunLock(lockDir, a);
  assert.equal(runningBriefing(lockDir, a).pid, process.pid);
  assert.throws(() => acquireRunLock(lockDir, a), (e) => e.code === 'SSS_BRIEFING_RUNNING');
  const releaseB = acquireRunLock(lockDir, b);
  releaseB();
  release();
  assert.equal(runningBriefing(lockDir, a), null);
  acquireRunLock(lockDir, a)();
});

test('실행 잠금 — 죽은 프로세스나 오래된 잠금은 없는 것으로 본다 (브리핑이 영영 막히지 않게)', () => {
  const lockDir = tmp('sss-lock2-');
  const wiki = tmp('sss-wc-');
  const release = acquireRunLock(lockDir, wiki);
  const [file] = readdirSync(lockDir);
  const lock = JSON.parse(readFileSync(join(lockDir, file), 'utf8'));
  release();
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, file), JSON.stringify({ ...lock, pid: 2 ** 22 + 7 })); // 없는 pid
  assert.equal(runningBriefing(lockDir, wiki), null);
  writeFileSync(join(lockDir, file), JSON.stringify({ ...lock, at: Date.now() - 121 * 60e3 })); // 살아 있어도 2시간 넘음 — pid 재사용
  assert.equal(runningBriefing(lockDir, wiki), null);
  acquireRunLock(lockDir, wiki)();
});

test('실행 잠금 — 같은 순간에 여럿이 잡아도(깨끗한 상태·죽은 잠금 상태) 쥐고 있는 구간이 겹치지 않는다', async () => {
  const lib = fileURLToPath(new URL('../lib/briefing.mjs', import.meta.url));
  // 모두 같은 시각까지 기다렸다가 잡는다. 잡았으면 쥔 구간(시작·끝)을 보고한다 — 늦게 뜬 프로세스가 풀린 뒤 잡는 건 정상
  const child = (lockDir, wiki, at) => new Promise((done) => {
    const code = `import { acquireRunLock } from ${JSON.stringify(lib)};
      while (Date.now() < ${at});
      try { const r = acquireRunLock(${JSON.stringify(lockDir)}, ${JSON.stringify(wiki)}); const t0 = performance.timeOrigin + performance.now();
        setTimeout(() => { const t1 = performance.timeOrigin + performance.now(); r(); console.log('got ' + t0 + ' ' + t1); }, 150); }
      catch (e) { console.log(e.code === 'SSS_BRIEFING_RUNNING' ? 'busy' : 'error ' + e.message); }`;
    const p = spawn(process.execPath, ['--input-type=module', '-e', code]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('exit', () => done(out.trim()));
  });
  for (let trial = 0; trial < 10; trial++) {
    const lockDir = tmp('sss-race-');
    const wiki = tmp('sss-wr-');
    if (trial % 5) {
      // 죽은 실행이 남긴 잠금에서 시작한다 — 넘겨받기 경쟁이 일어나는 쪽
      acquireRunLock(lockDir, wiki);
      const [f] = readdirSync(lockDir);
      writeFileSync(join(lockDir, f), JSON.stringify({ pid: 2 ** 22 + 7, at: Date.now(), started: 'x' }));
    }
    const at = Date.now() + 400;
    const outs = await Promise.all(Array.from({ length: 8 }, () => child(lockDir, wiki, at)));
    assert.ok(outs.every((o) => o.startsWith('got ') || o === 'busy'), outs.join(','));
    const held = outs.filter((o) => o.startsWith('got ')).map((o) => o.split(' ').slice(1).map(Number)).sort((a, b) => a[0] - b[0]);
    assert.ok(held.length >= 1, `trial ${trial}: 아무도 못 잡음`);
    for (let i = 1; i < held.length; i++) assert.ok(held[i][0] >= held[i - 1][1], `trial ${trial}: 두 실행이 동시에 쥠 ${JSON.stringify(held)}`);
  }
});
