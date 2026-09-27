/**
 * Phase 0 스파이크: 도구 네임스페이스 격리 검증
 *
 * 문제: agent.mjs 실행 시 우리 도구 2개만 allowedTools에 넣었는데도
 *       개발 환경(~/.claude)의 플러그인 MCP 도구 57개가 전부 노출됐다.
 *       배포된 앱이 사용자의 ~/.claude 설정을 상속하면
 *       - 컨텍스트 낭비 (도구 정의만 수천 토큰)
 *       - 예측 불가능한 동작 (에이전트가 남의 도구를 호출)
 *       - 사용자 환경마다 다른 동작
 *       이 문제는 반드시 앱 셸에서 차단해야 한다.
 *
 * 검증: settingSources / strictMcpConfig 조합으로 깨끗한 네임스페이스를 얻을 수 있는가?
 */
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const pingTool = tool('ping', '연결 확인용 도구', { x: z.string().default('hi') }, async ({ x }) => ({
  content: [{ type: 'text', text: `pong:${x}` }],
}));

const server = createSdkMcpServer({ name: 'ours', version: '0.1.0', tools: [pingTool] });

async function probe(label, extraOptions) {
  let tools = [];
  for await (const msg of query({
    prompt: '아무 도구도 호출하지 말고 "확인"이라고만 답해.',
    options: {
      mcpServers: { ours: server },
      allowedTools: ['mcp__ours__ping'],
      permissionMode: 'bypassPermissions',
      maxTurns: 1,
      ...extraOptions,
    },
  })) {
    if (msg.type === 'system' && msg.subtype === 'init') tools = msg.tools;
    if (msg.type === 'result') break;
  }

  const ours = tools.filter((t) => t.startsWith('mcp__ours__'));
  const foreign = tools.filter((t) => t.startsWith('mcp__') && !t.startsWith('mcp__ours__'));
  const builtin = tools.filter((t) => !t.startsWith('mcp__'));

  console.log(`\n【${label}】`);
  console.log(`  옵션        : ${JSON.stringify(extraOptions)}`);
  console.log(`  우리 도구   : ${ours.length}개 ${ours.join(', ')}`);
  console.log(`  외부 MCP    : ${foreign.length}개 ${foreign.length ? '⚠️  ' + foreign.slice(0, 3).join(', ') + (foreign.length > 3 ? ` 외 ${foreign.length - 3}개` : '') : '✅ 없음'}`);
  console.log(`  빌트인      : ${builtin.length}개 ${builtin.slice(0, 8).join(', ')}${builtin.length > 8 ? ' …' : ''}`);
  console.log(`  총 도구 수  : ${tools.length}`);
  return { label, total: tools.length, foreign: foreign.length, builtin: builtin.length, ours: ours.length };
}

const results = [];
results.push(await probe('A. 기본값 (agent.mjs와 동일)', {}));
results.push(await probe('B. settingSources 명시적 비움', { settingSources: [] }));
results.push(await probe('C. strictMcpConfig', { settingSources: [], strictMcpConfig: true }));
results.push(await probe('D. C + 빌트인 도구까지 차단', {
  settingSources: [],
  strictMcpConfig: true,
  disallowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
}));

console.log('\n' + '='.repeat(64));
console.log('요약'.padEnd(34) + '총'.padStart(5) + '외부MCP'.padStart(9) + '빌트인'.padStart(9));
console.log('='.repeat(64));
for (const r of results) {
  console.log(
    r.label.padEnd(34) +
      String(r.total).padStart(5) +
      String(r.foreign).padStart(9) +
      String(r.builtin).padStart(9) +
      (r.foreign === 0 ? '  ✅' : '  ⚠️'),
  );
}
console.log('='.repeat(64));
const clean = results.find((r) => r.foreign === 0 && r.ours > 0);
console.log(clean ? `\n✅ 격리 가능: "${clean.label}" 설정으로 외부 MCP 차단 확인` : '\n❌ 격리 실패 — 앱 셸에서 HOME/CLAUDE_CONFIG_DIR 격리 등 다른 수단 필요');
