import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tempWiki } from './helpers.mjs';
import { acquireRunLock } from '../lib/briefing.mjs';
import { WRITE_TOOLS } from '../../bin/sss.mjs';
import { kstDate } from '../lib/store.mjs';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const WIKI = tempWiki();
const CALL_LOG = join(mkdtempSync(join(tmpdir(), 'sss-log-')), 'calls.jsonl');
// 운영 도구가 실제 var/·launchd 를 건드리지 않게 — 설정·로그·잠금은 임시 폴더, launchctl 은 가짜
const OPS = mkdtempSync(join(tmpdir(), 'sss-ops-'));
const VAR = join(OPS, 'var');
const LAUNCHCTL = join(OPS, 'launchctl');
writeFileSync(LAUNCHCTL, `#!/bin/sh\ncase "$1" in bootstrap) touch ${JSON.stringify(join(OPS, 'loaded'))} ;; bootout) rm -f ${JSON.stringify(join(OPS, 'loaded'))} ;; print) [ -f ${JSON.stringify(join(OPS, 'loaded'))} ] || exit 113 ;; esac\n`);
chmodSync(LAUNCHCTL, 0o755);
const OPS_ENV = {
  SSS_VAR_DIR: VAR, SSS_LAUNCHD_DIR: join(OPS, 'LaunchAgents'), SSS_LAUNCHCTL: LAUNCHCTL,
  SSS_NO_NOTIFY: '1', SSS_ENV_FILE: join(OPS, 'no.env'),
};
let client;

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { isError: !!r.isError, text: r.content[0].text };
};

before(async () => {
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, ...OPS_ENV, SSS_MODE: 'chat', SSS_ACTIVE: 'chat · test-model', SSS_WIKI_DIR: WIKI, SSS_CALL_LOG: CALL_LOG, SSS_ALLOW_UNLICENSED: '1', DATA_GO_KR_KEY: '' },
      stderr: 'ignore',
    }),
  );
});
after(() => client?.close());

test('도구 목록 — 위키 4 · 판단 2 · 포트폴리오 3 · 브리핑·제안 4 · 운영 4 · 한국 공시 4 · 미국 공시 2 · 한국 시세 2', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'briefing_inbox', 'briefing_run', 'briefing_schedule', 'dart_filing_text', 'dart_filings', 'dart_financials', 'decision_record', 'decision_update',
    'find_company', 'find_similar_cases', 'holdings_update', 'model_settings', 'portfolio_get', 'price_history',
    'proposal_add', 'proposal_list', 'proposal_resolve', 'quote',
    'recent_filings', 'system_status', 'watchlist_update', 'wiki_graph_query', 'wiki_search', 'wiki_status', 'xbrl_concept',
  ]);
});

// 목록에 없는 도구는 승인 없이 실행된다 (default_tools_approval_mode="approve") — 새 도구가 조용히 자동 승인되지 않게 전부 분류한다
const AUTO_APPROVED = [
  'wiki_search', 'wiki_graph_query', 'find_similar_cases', 'wiki_status', 'portfolio_get', 'briefing_inbox', 'proposal_list', 'system_status',
  'find_company', 'dart_filings', 'dart_filing_text', 'dart_financials', 'recent_filings', 'xbrl_concept', 'quote', 'price_history',
  'proposal_add', // 쓰기지만 위키 페이지가 아니라 대기열 — 브리핑(exec)이 남겨야 한다
];
test('모든 도구는 승인 대상(WRITE_TOOLS) 또는 명시된 자동 승인 목록 중 하나 — 판단·보유·운영을 바꾸는 도구는 승인 대상', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...WRITE_TOOLS, ...AUTO_APPROVED].sort());
  assert.ok(!WRITE_TOOLS.some((t) => AUTO_APPROVED.includes(t)));
  for (const t of ['briefing_schedule', 'briefing_run', 'model_settings', 'decision_record', 'holdings_update']) assert.ok(WRITE_TOOLS.includes(t), t);
});

test('운영 도구는 실행 모드를 모르면(SSS_MODE 없음) 막는다 — 실행기 밖에서 서버만 띄운 경우', async () => {
  const bare = new Client({ name: 'test-bare', version: '0.0.0' });
  // .env 는 실행 모드·세션 표시 같은 SSS_ 값을 바꾸지 못한다 — 사용자 설정 두 개만 읽는다
  const dotenv = join(OPS, 'bare.env');
  writeFileSync(dotenv, 'SSS_MODE=chat\nSSS_ACTIVE=from-dotenv\n');
  const env = { ...process.env, ...OPS_ENV, SSS_ENV_FILE: dotenv, SSS_WIKI_DIR: tempWiki(), SSS_CALL_LOG: join(OPS, 'bare-calls.jsonl') };
  delete env.SSS_MODE;
  delete env.SSS_ACTIVE;
  await bare.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER], env, stderr: 'ignore' }));
  try {
    const r = await bare.callTool({ name: 'briefing_schedule', arguments: { action: 'uninstall' } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /자동 실행에서는/);
    const st = JSON.parse((await bare.callTool({ name: 'system_status', arguments: {} })).content[0].text);
    assert.equal(st.this_session, null);
  } finally {
    await bare.close();
  }
});

test('price_history 는 실시간 opt-in 을 켜도 비공식으로 폴백하지 않는다 — 위키 정본이라서', async () => {
  // 이 서버는 SSS_ALLOW_UNLICENSED=1 로 떠 있고 DATA_GO_KR_KEY 는 없다
  const r = await call('price_history', { code: '005930' });
  assert.equal(r.isError, true);
  assert.match(r.text, /공식 키 미설정/);
});

test('시세 도구는 라이선스 opt-in 을 인자로 받지 않는다 — 모델이 스스로 켤 수 없다', async () => {
  const { tools } = await client.listTools();
  const quote = tools.find((t) => t.name === 'quote');
  assert.deepEqual(Object.keys(quote.inputSchema.properties), ['code']);
});

test('MCP 로 위키 검색', async () => {
  const r = await call('wiki_search', { q: '하이닉스' });
  assert.equal(r.isError, false);
  assert.ok(JSON.parse(r.text).rows.some((x) => x.id === 'company-sk-hynix'));
});

test('wiki_status — 결과가 기록된 판단은 열린 판단에서 빠진다', async () => {
  const s = JSON.parse((await call('wiki_status')).text);
  assert.equal(s.nodes, 7);
  assert.deepEqual(s.invalid, []);
  assert.deepEqual(s.open_decisions, []);
});

test('사용자 확인 없는 판단 기록은 도구 에러로 돌려준다 (서버는 살아 있다)', async () => {
  const r = await call('decision_record', {
    slug: 'nvda-buy', title: '엔비디아 매수 테스트', about: ['company-nvidia'], action: '매수',
    thesis: '열 글자 이상의 논지입니다', confidence: 6, expected_outcome: '상승 기대', invalidation_condition: '다음 분기 매출 역성장 시 무효',
    time_horizon: '6개월',
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /user_confirmed/);
  assert.equal((await call('wiki_search', { q: '엔비디아' })).isError, false);
});

test('도구가 실행된 호출은 성공·실패 모두 호출 기록에 남는다', async () => {
  // 스키마 위반은 SDK 가 핸들러 전에 거부하므로 기록되지 않는다 — 여기선 핸들러까지 간 실패를 본다
  const r = await call('decision_record', {
    slug: 'ghost-buy', title: '없는 종목 판단', about: ['company-ghost'], action: '매수',
    thesis: '열 글자 이상의 논지입니다', confidence: 6, expected_outcome: '상승 기대', invalidation_condition: '다음 분기 매출 역성장 시 무효',
    time_horizon: '6개월', user_confirmed: true,
  });
  assert.equal(r.isError, true);
  const lines = readFileSync(CALL_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.every((l) => l.wiki === WIKI && Number.isInteger(l.pid)), '동시 세션을 가려낼 수 있게 위키 경로·pid 를 남긴다');
  assert.ok(lines.some((l) => l.tool === 'wiki_search' && l.ok));
  assert.ok(lines.some((l) => l.tool === 'decision_record' && !l.ok && /위키에 없는 노드: company-ghost/.test(l.error)));
});

test('MCP 로 보유를 적고 비중을 읽는다 — 위키 폴더의 portfolio.yaml 에 남는다', async () => {
  const w = await call('holdings_update', {
    positions: [{ market: 'KR', code: '000660', name: 'SK하이닉스', quantity: 10, avg_price: 200000 }],
    cash: { KRW: 2000000 }, user_confirmed: true,
  });
  assert.equal(w.isError, false, w.text);
  const p = JSON.parse((await call('portfolio_get')).text);
  assert.equal(p.holdings[0].weight, 0.5);
  assert.match(p.basis, /원가 기준/);
  assert.match(readFileSync(join(WIKI, 'portfolio.yaml'), 'utf8'), /SK하이닉스/);
});

test('제안 대기열 — 대화형 서버에서는 추가·조회·처리가 된다', async () => {
  const add = JSON.parse((await call('proposal_add', {
    key: 'dart:20260918000123', kind: 'other', title: '테스트 제안입니다', reason: '열 글자 이상의 이유를 적는다',
    sources: ['https://dart.fss.or.kr/x'],
  })).text);
  assert.equal(add.duplicate, false);
  assert.equal(JSON.parse((await call('proposal_list')).text).total, 1);
  const r = await call('proposal_resolve', { id: add.id, status: 'rejected', note: '테스트', user_confirmed: true });
  assert.equal(r.isError, false, r.text);
});

test('자동 실행(SSS_MODE=exec) 서버는 제안 처리를 거부한다 — 사용자 결정을 대신하지 않는다', async () => {
  const wiki = tempWiki();
  const exec = new Client({ name: 'test-exec', version: '0.0.0' });
  await exec.connect(new StdioClientTransport({
    command: process.execPath, args: [SERVER],
    env: { ...process.env, ...OPS_ENV, SSS_WIKI_DIR: wiki, SSS_CALL_LOG: CALL_LOG, SSS_MODE: 'exec' }, stderr: 'ignore',
  }));
  try {
    const run = async (name, args) => (await exec.callTool({ name, arguments: args })).content[0].text;
    const { id } = JSON.parse(await run('proposal_add', {
      key: 'dart:1', kind: 'other', title: '자동 실행 제안', reason: '열 글자 이상의 이유를 적는다', sources: ['https://x.y/z'],
    }));
    assert.match(await run('proposal_resolve', { id, status: 'accepted', user_confirmed: true }), /자동 실행에서는 제안을 처리하지 않는다/);
    // 무인 브리핑은 외부 공시 본문을 읽는다 — 거기 심긴 지시가 예약·실행·모델 설정을 바꾸지 못하게
    assert.match(await run('briefing_schedule', { action: 'install', time: '03:00' }), /자동 실행에서는/);
    assert.match(await run('briefing_schedule', { action: 'uninstall' }), /자동 실행에서는/);
    assert.match(await run('briefing_run', {}), /자동 실행에서는/);
    assert.match(await run('model_settings', { route: 'briefing', model: 'gpt-6-astra' }), /자동 실행에서는/);
    assert.ok(!existsSync(join(OPS, 'LaunchAgents')) && !existsSync(join(VAR, 'settings.json')));
    assert.ok(!existsSync(join(wiki, 'briefings')) || readdirSync(join(wiki, 'briefings')).every((f) => !f.endsWith('.md')));
    assert.ok(JSON.parse(await run('system_status', {})).models, '상태 조회는 된다');
  } finally {
    await exec.close();
  }
});

test('system_status — 예약·브리핑·모델·키 설정 여부를 보여주되 키 값은 주지 않는다', async () => {
  const r = await call('system_status');
  assert.equal(r.isError, false, r.text);
  const st = JSON.parse(r.text);
  assert.deepEqual(Object.keys(st.models[0]).sort(), ['default', 'effort', 'model', 'problem', 'route', 'source', 'what']);
  assert.deepEqual(st.models.map((m) => m.route), ['chat', 'deep', 'exec', 'briefing']);
  assert.ok(Object.values(st.keys).every((v) => typeof v === 'boolean'), '값이 아니라 설정 여부만');
  assert.equal(st.schedule.registered, false);
  assert.equal(st.this_session, 'chat · test-model', '실행기가 알려준 지금 대화의 모델');
});

test('briefing_schedule — 대화에서 예약·시각 변경·해제, system_status 에 반영', async () => {
  const on = JSON.parse((await call('briefing_schedule', { action: 'install', time: '07:10' })).text);
  assert.equal(on.time, '07:10');
  const plist = readFileSync(on.plist, 'utf8');
  assert.match(plist, new RegExp(`<key>SSS_WIKI_DIR</key><string>${WIKI}</string>`), '이 서버의 위키로 예약한다');
  assert.match(plist, /<string>briefing<\/string>/);
  assert.equal(JSON.parse((await call('system_status')).text).schedule.time, '07:10');
  assert.equal((await call('briefing_schedule', { action: 'install', time: '7시' })).isError, true);
  assert.equal(JSON.parse((await call('briefing_schedule', { action: 'uninstall' })).text).removed, true);
  assert.equal(JSON.parse((await call('system_status')).text).schedule.registered, false);
});

test('model_settings — 목록에 없는 모델은 저장하지 않는다', async () => {
  const r = await call('model_settings', { route: 'briefing', model: 'gpt-nonexistent-9' });
  assert.equal(r.isError, true);
  assert.ok(!existsSync(join(VAR, 'settings.json')));
  assert.equal((await call('model_settings', { route: 'chat', effort: 'turbo' })).isError, true, '강도는 정해진 값만');
});

test('briefing_run — 백그라운드로 돌려 브리핑 파일을 남기고, 이미 돌고 있으면 새로 띄우지 않는다', async () => {
  const release = acquireRunLock(VAR, WIKI);
  try {
    const busy = JSON.parse((await call('briefing_run', { no_llm: true })).text);
    assert.equal(busy.started, false);
    assert.equal(busy.running.pid, process.pid);
  } finally {
    release();
  }
  spawnSync(process.execPath, [join(dirname(SERVER), '..', 'bin', 'sss.mjs'), 'init'], { env: { ...process.env, SSS_WIKI_DIR: WIKI } });
  const r = JSON.parse((await call('briefing_run', { no_llm: true })).text);
  assert.equal(r.started, true);
  // 종목이 없어 모델·네트워크 없이 안내 브리핑만 쓴다
  const file = join(WIKI, 'briefings', `${kstDate()}.md`);
  for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise((ok) => setTimeout(ok, 100));
  assert.ok(existsSync(file), '분리된 실행이 브리핑을 썼다');
  assert.match(readFileSync(join(VAR, 'briefing.log'), 'utf8'), /\[briefing /);
});
