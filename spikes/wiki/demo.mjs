/**
 * Phase 0 스파이크: 위키 지식그래프 계층 검증
 *
 * 검증 대상 — 제품 설계의 핵심 주장 4가지
 *   1. 한국어 검색이 2글자/3글자 모두 동작하는가
 *   2. 관계 기반 탐색으로 "무엇이 이 종목에 영향을 주는가"를 답할 수 있는가
 *   3. 바이템포럴: "그때는 참이었지만 지금은 아닌" 사실을 구분할 수 있는가
 *   4. 유사 과거 상황에서 내 판단과 결과를 소환할 수 있는가
 */
import { buildIndex, search, traverse, findSimilarCases } from './index.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const { db, stats } = buildIndex(join(here, 'wiki'));

const hr = (t) => console.log('\n' + '─'.repeat(66) + `\n${t}\n` + '─'.repeat(66));

console.log(`인덱스 구축: 노드 ${stats.nodes} · 엣지 ${stats.edges} · 끊긴 링크 ${stats.dangling.length ? stats.dangling.join(', ') : '없음 ✅'}`);

// ── 1. 한국어 검색 ────────────────────────────────────────────────
hr('[1] 한국어 검색 — 2글자와 3글자 모두');
for (const q of ['실적', '하이닉스', 'HBM 수요']) {
  const { mode, rows } = search(db, q, 3);
  console.log(`\n  "${q}"  → ${mode}`);
  rows.forEach((r) => console.log(`     ${r.type.padEnd(8)} ${r.title}`));
  if (!rows.length) console.log('     (결과 없음)');
}

// ── 2. 관계 탐색 ──────────────────────────────────────────────────
hr('[2] 관계 탐색 — SK하이닉스에 연결된 것들 (2-hop)');
for (const r of traverse(db, 'company-sk-hynix', { hops: 2 })) {
  console.log(`  ${'·'.repeat(r.depth)} [${r.type}] ${r.title}${r.date ? '  (' + r.date + ')' : ''}`);
}

// ── 3. 바이템포럴 ─────────────────────────────────────────────────
hr('[3] 바이템포럴 — 같은 질문, 다른 시점');
const asOfQuery = db.prepare(`
  SELECT e.src, e.rel, e.direction, e.confidence, e.valid_from, e.valid_until, e.note, n.title
  FROM edges e JOIN nodes n ON n.id = e.src
  WHERE e.dst = 'company-sk-hynix' AND e.rel = 'affects'
    AND (e.valid_from IS NULL OR e.valid_from <= ?)
    AND (e.valid_until IS NULL OR e.valid_until > ?)
  ORDER BY e.valid_from`);

for (const asOf of ['2024-09-01', '2026-08-19']) {
  console.log(`\n  ▸ ${asOf} 시점에 "SK하이닉스에 영향을 준다"고 유효했던 사실:`);
  const rows = asOfQuery.all(asOf, asOf);
  if (!rows.length) console.log('     (없음)');
  for (const r of rows) {
    console.log(`     ${r.direction ?? ' '} ${r.title}  (확신도 ${r.confidence})`);
    if (r.note) console.log(`       └ ${r.note}`);
  }
}
console.log(`\n  ⇒ 2024-08 블랙웰 지연의 부정적 영향은 2024-11-20자로 무효화되어`);
console.log(`     2026 시점 조회에서 사라졌다. 페이지는 삭제되지 않고 역사로 남아 있다.`);

// ── 4. 유사 케이스 소환 ───────────────────────────────────────────
hr('[4] 유사 과거 상황 소환 — 오늘 루빈 지연 루머가 떴다면');
const current = db.prepare(`SELECT title, date FROM nodes WHERE id = ?`).get('event-rubin-delay-rumor-2026');
console.log(`  현재 상황: ${current.title} (${current.date})\n`);

for (const c of findSimilarCases(db, 'event-rubin-delay-rumor-2026')) {
  const d = c.decision;
  console.log(`  📌 과거 유사 판단: ${c.title} (${c.date})`);
  console.log(`     매칭 근거   : 태그 ${c.tag_overlap}개 일치${c.linked ? ' + similar-to 명시 링크' : ''}`);
  console.log(`     당시 논지   : ${d.thesis}`);
  console.log(`     확신도      : ${d.confidence}/10 → 무효화 조건: ${d.invalidation_condition}`);
  console.log(`     실제 결과   : ${d.actual_outcome}`);
  console.log(`     교훈        : ${d.lesson}`);
}

hr('검증 결과');
const checks = [
  ['한국어 2글자 검색 ("실적")', search(db, '실적').rows.length > 0],
  ['한국어 부분어 검색 ("하이닉스")', search(db, '하이닉스').rows.length > 0],
  ['관계 기반 2-hop 탐색', traverse(db, 'company-sk-hynix', { hops: 2 }).length > 0],
  // 개수 비교는 틀린 검증이다 — 2026 시점엔 새 사실이 추가돼 개수가 오히려 늘어난다.
  // 검증해야 할 것은 "무효화된 그 사실이 과거 시점에는 보이고 현재 시점에는 안 보이는가"이다.
  [
    '바이템포럴: 무효화된 사실이 과거 시점에만 보임',
    asOfQuery.all('2024-09-01', '2024-09-01').some((r) => r.src === 'event-blackwell-delay-2024') &&
      !asOfQuery.all('2026-08-19', '2026-08-19').some((r) => r.src === 'event-blackwell-delay-2024'),
  ],
  [
    '바이템포럴: 무효화 후에도 페이지는 보존됨',
    !!db.prepare(`SELECT 1 FROM nodes WHERE id = 'event-blackwell-delay-2024'`).get(),
  ],
  ['유사 케이스 + 결과·교훈 소환', findSimilarCases(db, 'event-rubin-delay-rumor-2026').length > 0],
  ['끊긴 링크 없음', stats.dangling.length === 0],
];
for (const [name, pass] of checks) console.log(`  ${pass ? '✅' : '❌'} ${name}`);
console.log();
process.exit(checks.every(([, p]) => p) ? 0 : 1);
