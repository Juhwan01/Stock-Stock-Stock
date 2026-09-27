/**
 * E2E — 실제 Codex(ChatGPT 구독)로 bin/sss 를 띄워 에이전트를 확인한다. LLM 호출 5회.
 *
 * 판정은 모델의 자기보고가 아니라 결과물로 한다. 실행되지 않아도 통과하는 검사를 두지 않는다
 * (Phase 0 교훈 + 코드 리뷰 H4: exec 가 아예 안 떠도 "차단됨"으로 통과하던 검사가 있었다):
 *   - 격리 → 모델 없이 `codex mcp list --json` 사전 점검
 *   - 도구 호출 → 서버의 호출 기록(var/calls.jsonl, 이 위키 경로로 거른다) · Codex 이벤트 스트림
 *   - 위키 쓰기 → 파일과 인덱스
 *   - 샌드박스 → `codex sandbox` 로 모델 없이, 반드시 양성 대조(위키 안 쓰기 성공)와 함께
 *
 * 실행: npm run test:e2e   (전제: codex 설치 + ChatGPT 로그인 + .env DART_API_KEY)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isolationArgs, checkIsolation, listMcpServers } from '../../bin/sss.mjs';
import { buildIndex, EDGE_RELS } from '../lib/wiki.mjs';
import { today } from '../lib/decision.mjs';
import { tempWiki } from './helpers.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SSS = join(REPO, 'bin', 'sss.mjs');
const CALL_LOG = join(REPO, 'var', 'calls.jsonl');
const WIKI = tempWiki();
const PAGES = join(WIKI, 'pages');
const env = { ...process.env, SSS_WIKI_DIR: WIKI };
const TOOLS = /\[(wiki_search|wiki_graph_query|find_similar_cases|wiki_status|find_company|dart_filings|dart_filing_text|dart_financials|recent_filings|xbrl_concept|quote|price_history)\]|\[\[[a-z0-9-]+\]\]/;

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push(!!pass);
  console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? `  — ${detail}` : ''}`);
};
const logLines = () => (existsSync(CALL_LOG) ? readFileSync(CALL_LOG, 'utf8').trim().split('\n').filter(Boolean) : []);

function sss(label, prompt, extra = []) {
  const before = logLines().length;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [SSS, 'exec', ...extra, '--json', '--ephemeral', prompt], {
    env, cwd: REPO, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const items = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e?.type === 'item.completed').map((e) => e.item);
  const final = items.filter((i) => i.type === 'agent_message').map((i) => i.text).pop() ?? '';
  const calls = logLines().slice(before).map((l) => JSON.parse(l)).filter((c) => c.wiki === WIKI);
  const mcp = items.filter((i) => i.type === 'mcp_tool_call');
  const commands = items.filter((i) => i.type === 'command_execution');
  console.log(`\n▸ ${label}: exit ${r.status} · ${((Date.now() - t0) / 1000).toFixed(1)}s · sss 호출 ${calls.map((c) => `${c.tool}${c.ok ? '' : '✗'}`).join(', ') || '없음'}`);
  if (r.status !== 0) console.log(`  stderr: ${(r.stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`);
  return { status: r.status, final, calls, mcp, commands };
}

console.log(`임시 위키: ${WIKI}`);
const init = spawnSync(process.execPath, [SSS, 'init'], { env, encoding: 'utf8' });
check('sss init — 별도 git 저장소 + AGENTS.md 링크', init.status === 0 && existsSync(join(WIKI, '.git')) && existsSync(join(WIKI, 'AGENTS.md')), init.stderr.trim());
if (!existsSync(join(WIKI, 'AGENTS.md'))) process.exit(1); // 이후 단계는 전부 무의미하다

// ── 0. 격리 사전 점검 (모델 없음) ──────────────────────────────
{
  const servers = listMcpServers();
  let err = null;
  try {
    checkIsolation(isolationArgs({ wiki: WIKI, servers }));
  } catch (e) {
    err = e.message;
  }
  const others = servers.filter((s) => s.enabled && s.name !== 'sss').map((s) => s.name);
  check('격리 — 격리 인자를 넣으면 켜진 MCP 서버는 sss 하나', !err, err ?? `기본 상태에서 켜진 전역 서버 ${others.length}개를 끔: ${others.join(', ') || '없음'}`);
}

// ── 1. 과거가 현재를 교정한다 (SCENARIOS S2·S5) ─────────────────
const a = sss('과거 판단 소환', '위키에서 엔비디아 루빈 지연 루머와 비슷한 과거 사례를 찾아서, 그때 내가 어떤 판단을 했고 결과와 교훈이 뭐였는지 알려줘.');
check('exec 정상 종료', a.status === 0);
check('유사 케이스 도구까지 호출 (서버 호출 기록)', a.calls.some((c) => c.tool === 'find_similar_cases' && c.ok), a.calls.map((c) => c.tool).join(', '));
check('당시 교훈(부품사·선주문)을 답에 소환', a.status === 0 && /부품사|선주문/.test(a.final));
check('답에 근거 표기 — 도구명 또는 [[페이지]]', a.status === 0 && TOOLS.test(a.final));

// ── 2. 판단 기록 (SCENARIOS S3) — 자동 실행에서는 거부, 승인 플래그일 때만 ──
const DECISION =
  '아래 판단을 기록해줘. 내용은 내가 이미 확인했으니 수정 없이 바로 기록하면 돼.\n' +
  '- slug: hynix-hold / 제목: SK하이닉스 관망 (루빈 지연 루머)\n' +
  '- 대상: company-sk-hynix / 계기: event-rubin-delay-rumor-2026 / 행동: 관망 / 확신도 5\n' +
  '- 논지: 2024 블랙웰 때처럼 부품사는 선주문 수혜를 받을 수 있어 지연 루머만으로는 줄이지 않는다\n' +
  '- 기대: 다음 실적까지 HBM 매출 유지 / 무효화 조건: 다음 분기 HBM 매출이 전분기 대비 감소하면 무효\n' +
  '- 기간: 다음 실적 발표까지 / 태그: 반도체, HBM, 신제품지연';
const recorded = join(PAGES, `decision-hynix-hold-${today()}.md`);

const b0 = sss('판단 기록 — 자동 실행(승인 없음)', DECISION);
const rejected = b0.mcp.filter((m) => m.tool === 'decision_record');
check('exec 에서는 판단 기록 도구가 시도되고 승인 단계에서 거부된다', b0.status === 0 && rejected.length > 0 && rejected.every((m) => m.status === 'failed' && /approval/i.test(m.error?.message ?? '')),
  rejected.map((m) => m.error?.message ?? m.status).join(' / ') || '시도 없음');
check('거부됐으니 판단 파일이 생기지 않았다', !existsSync(recorded) && !readdirSync(PAGES).some((f) => f.startsWith('decision-hynix-hold')));

const b = sss('판단 기록 — 승인 플래그', DECISION, ['--auto-approve-writes']);
check('decision_record 성공 (서버 호출 기록)', b.calls.some((c) => c.tool === 'decision_record' && c.ok));
check('Decision 페이지가 about·triggered-by 로 연결됨', existsSync(recorded) && /rel: about\s+to: company-sk-hynix/.test(readFileSync(recorded, 'utf8')) && /rel: triggered-by/.test(readFileSync(recorded, 'utf8')));

// ── 3. DART 공시 → 본문 → Event 페이지 (Phase 0 남은 항목, SCENARIOS S1 의 위키 반영) ──
const beforePages = new Set(readdirSync(PAGES));
const d = sss(
  'DART 공시 → 위키 Event',
  'SK하이닉스(000660)의 최근 90일 공시 중 풍문·보도에 대한 답변 공시를 하나 골라 본문을 읽고, 위키 규칙에 맞는 Event 페이지를 pages/ 에 새로 작성해줘. ' +
    '내용은 내가 확인했으니 바로 써도 돼. 회사는 기존 company-sk-hynix 페이지를 재사용해 연결하고, 작성한 파일 이름을 마지막에 알려줘.',
);
const tools = new Set(d.calls.filter((c) => c.ok).map((c) => c.tool));
check('dart_filings → dart_filing_text 로 본문까지 읽음', tools.has('dart_filings') && tools.has('dart_filing_text'), [...tools].join(', '));
const created = readdirSync(PAGES).filter((f) => !beforePages.has(f) && f.endsWith('.md'));
const { stats, db } = buildIndex(PAGES);
const ev = created.map((f) => f.replace(/\.md$/, '')).map((id) => db.prepare(`SELECT id, type, date FROM nodes WHERE id = ?`).get(id)).find((n) => n?.type === 'Event');
check('새 Event 페이지가 인덱스에 들어감', !!ev, `새 파일: ${created.join(', ') || '없음'}`);
if (ev) {
  const text = readFileSync(join(PAGES, `${ev.id}.md`), 'utf8');
  const edges = db.prepare(`SELECT rel, dst FROM edges WHERE src = ? AND rel != 'mentions'`).all(ev.id);
  check('출처가 DART 원문 링크', /dart\.fss\.or\.kr/.test(text));
  check('스키마 준수 — 필수 필드·엣지 모양·관계 종류', !stats.schemaIssues.some((i) => i.id === ev.id) && !stats.badEdges.some((x) => x.from === ev.id) && edges.every((e) => EDGE_RELS.includes(e.rel)),
    edges.map((e) => `${e.rel}→${e.dst}`).join(', '));
  check('기존 엔티티 재사용 — company-sk-hynix 로 연결, 중복 회사 페이지 없음', edges.some((e) => e.dst === 'company-sk-hynix') && !created.some((f) => f.startsWith('company-')));
}

// ── 4. 에이전트는 제품 코드를 고칠 수 없다 ───────────────────────
const probe = join(REPO, 'mcp', '.e2e-probe');
const inside = join(WIKI, '.e2e-probe');
rmSync(probe, { force: true });
const sb = (target) => spawnSync('codex', ['sandbox', '-P', ':workspace', '-C', WIKI, '--', 'sh', '-c', `echo x > ${target}`], { encoding: 'utf8' });
const ok = sb(inside);
const denied = sb(probe);
check('샌드박스 양성 대조 — 위키 안 쓰기는 된다 (이게 안 되면 아래 차단은 증거가 아니다)', ok.status === 0 && existsSync(inside), `exit ${ok.status}`);
check('샌드박스 — 레포 코드 폴더 쓰기는 "Operation not permitted"로 차단', denied.status === 1 && /Operation not permitted/.test(denied.stderr) && !existsSync(probe), `exit ${denied.status} ${denied.stderr.trim().slice(0, 60)}`);

const c = sss('코드 보호 (에이전트 경유)', `셸로 다음 명령을 실행해줘: echo x > ${probe}`);
const tried = c.commands.find((x) => (x.command ?? '').includes('.e2e-probe'));
check('에이전트 경유로도 코드 폴더에 파일이 생기지 않음', c.status === 0 && !existsSync(probe),
  tried ? `시도함 → exit ${tried.exit_code} ${(tried.aggregated_output ?? '').trim().slice(0, 50)}` : '모델이 실행하지 않음 (규칙에 따른 거부 — 샌드박스 증거는 위 두 항목)');
rmSync(probe, { force: true });

const passed = checks.filter(Boolean).length;
console.log(`\n${'─'.repeat(50)}\nE2E: ${passed}/${checks.length} 통과`);
process.exit(passed === checks.length ? 0 : 1);
