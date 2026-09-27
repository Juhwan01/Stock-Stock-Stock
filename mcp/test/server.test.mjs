import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { tempWiki } from './helpers.mjs';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const WIKI = tempWiki();
const CALL_LOG = join(mkdtempSync(join(tmpdir(), 'sss-log-')), 'calls.jsonl');
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
      env: { ...process.env, SSS_WIKI_DIR: WIKI, SSS_CALL_LOG: CALL_LOG, SSS_ALLOW_UNLICENSED: '1', DATA_GO_KR_KEY: '' },
      stderr: 'ignore',
    }),
  );
});
after(() => client?.close());

test('도구 목록 — 위키 4 · 판단 2 · 한국 공시 4 · 미국 공시 2 · 한국 시세 2', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'dart_filing_text', 'dart_filings', 'dart_financials', 'decision_record', 'decision_update',
    'find_company', 'find_similar_cases', 'price_history', 'quote',
    'recent_filings', 'wiki_graph_query', 'wiki_search', 'wiki_status', 'xbrl_concept',
  ]);
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
