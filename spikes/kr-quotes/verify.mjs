/**
 * 어댑터 검증 — 계층 분리가 실제로 작동하는가
 *
 * 검증 목표
 *  1. 현재가 폴백이 동작하는가 (네이버 → 야후)
 *  2. 히스토리가 공식 키 없을 때 degraded 로 표시되며 폴백하는가
 *  3. official=false 데이터를 위키에 못 쓰게 막을 수 있는가 (불변식)
 *  4. 야후 페이싱이 429를 실제로 막는가
 */
import { quote, history, sources } from './adapter.mjs';

const KST = (d) => new Date(d).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
const checks = [];
const check = (name, pass, detail = '') => { checks.push([name, pass]); console.log(`  ${pass ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`); };

console.log(`검증 시각: ${KST(Date.now())} KST\n`);

// ── 1. 현재가 (기본 우선순위) ─────────────────────────────────────
console.log('【1】 현재가 조회 — 기본값은 라이선스 opt-in 소스를 제외한다');
const q = await quote('005930');
console.log(`  ${q.name} ${q.price.toLocaleString('ko-KR')}원 · 지연 ${q.lagMinutes.toFixed(1)}분 · 출처 ${q.source}`);
check('현재가 조회 성공', q.price > 0);
check('official 플래그가 false (휘발성 데이터)', q.official === false);
check('기본값이 포털 스크래핑을 쓰지 않음', !['naver', 'daum'].includes(q.source), `선택됨: ${q.source}`);

console.log('\n【1-b】 사용자가 명시적으로 켰을 때만 포털 소스 사용');
const qOptIn = await quote('005930', { allowUnlicensed: true });
console.log(`  ${qOptIn.source} · 지연 ${qOptIn.lagMinutes.toFixed(1)}분`);
check('opt-in 시 실시간 확보', qOptIn.lagMinutes < q.lagMinutes, `${qOptIn.lagMinutes.toFixed(1)}분 vs ${q.lagMinutes.toFixed(1)}분`);

// ── 2. 교차검증 — 반드시 같은 세션끼리만 비교해야 한다 ────────────
console.log('\n【2】 소스 간 교차검증');
console.log(`  ${q.source}(${q.session ?? 'regular'}) ${q.price.toLocaleString('ko-KR')}원`);
console.log(`  ${qOptIn.source}(${qOptIn.session ?? '?'}) ${qOptIn.price.toLocaleString('ko-KR')}원`);

const sameSession = (q.session ?? 'regular') === (qOptIn.session ?? 'regular');
if (sameSession) {
  check('같은 세션 가격이 일치 (2% 이내)', Math.abs(q.price - qOptIn.price) / q.price < 0.02);
} else {
  // 시간외 단일가와 정규장 종가는 다른 값이 정상이다. 이걸 섞으면 앱이 거짓말을 한다.
  const gap = ((qOptIn.price - q.price) / q.price) * 100;
  console.log(`  ⓘ 세션이 달라 값이 갈린다 (${gap >= 0 ? '+' : ''}${gap.toFixed(2)}%) — 비교 대상이 아님`);
  check('세션이 다를 때 이를 구분해 표기함', !!qOptIn.session,
    '세션 표기가 없으면 시간외 가격을 종가로 오인하게 된다');
}

// 정규장끼리 비교 — 야후와 다음은 둘 다 정규장 기준이라 직접 비교 가능
const qd = await sources.daum.quote('005930');
console.log(`  daum(regular) ${qd.price.toLocaleString('ko-KR')}원`);
check('정규장 기준 두 소스가 일치 (야후 vs 다음)', Math.abs(q.price - qd.price) / q.price < 0.02,
  `${q.price.toLocaleString('ko-KR')} vs ${qd.price.toLocaleString('ko-KR')}`);

// ── 3. 존재하지 않는 소스 전부 실패 시 ────────────────────────────
console.log('\n【3】 전 소스 실패 시 에러 전파');
let threw = false;
try { await quote('999999', { prefer: ['yahoo'] }); } catch { threw = true; }
check('잘못된 종목코드에서 에러 발생 (조용한 오답 아님)', threw);

// ── 4. 히스토리 — 공식 키 없을 때 조용히 폴백하지 않는가 ──────────
console.log('\n【4】 히스토리 — 공식 키 미설정 시 라이선스 게이트');
let gated = false, gateMsg = '';
try {
  await history('005930', { serviceKey: undefined });
} catch (e) {
  gated = e.code === 'NEEDS_OFFICIAL_KEY';
  gateMsg = e.message.split('\n')[0];
}
console.log(`  ${gateMsg}`);
check('위키 정본 데이터가 비공식 소스로 조용히 폴백하지 않음', gated);

console.log('\n【4-b】 명시적 허용 시에만 폴백');
const h = await history('005930', { serviceKey: undefined, allowUnlicensed: true });
console.log(`  ${h.rows.length}개 · 출처 ${h.source} · official=${h.official} · degraded=${h.degraded} · 사유: ${h.reason}`);
check('명시 허용 시 히스토리 확보', h.rows.length > 1000);
check('degraded 로 명확히 표시됨', h.degraded === true && h.official === false);

// ── 5. 불변식: 비공식 데이터는 위키에 커밋 불가 ───────────────────
console.log('\n【5】 불변식 — official=false 데이터의 위키 커밋 차단');
function commitToWiki(rows) {
  const bad = rows.filter((r) => !r.official);
  if (bad.length) throw new Error(`비공식 출처 데이터 ${bad.length}건은 위키에 커밋할 수 없다 (출처: ${bad[0].source})`);
  return rows.length;
}
let blocked = false;
try { commitToWiki(h.rows); } catch (e) { blocked = true; console.log(`  차단됨: ${e.message.slice(0, 60)}…`); }
check('비공식 데이터가 위키 커밋에서 차단됨', blocked);

// ── 6. 야후 페이싱이 429를 막는가 ─────────────────────────────────
console.log('\n【6】 야후 페이싱 — 연속 5회 (어댑터가 1.1초 간격 강제)');
const t0 = Date.now();
const codes = ['005930', '000660', '035420', '005380', '051910'];
const results = [];
for (const c of codes) {
  try { const r = await sources.yahoo.quote(c); results.push(`${r.name.slice(0, 12)} ✓`); }
  catch (e) { results.push(`${c} ✗ ${e.status ?? e.message}`); }
}
const elapsed = (Date.now() - t0) / 1000;
console.log(`  ${results.join(' · ')}`);
console.log(`  소요 ${elapsed.toFixed(1)}초 (페이싱 강제 확인)`);
check('페이싱 하에 야후 5연속 성공 (429 없음)', results.every((r) => r.includes('✓')));
check('페이싱이 실제로 적용됨 (5회 ≥ 4.4초)', elapsed >= 4.4);

console.log('\n' + '─'.repeat(58));
const passed = checks.filter(([, p]) => p).length;
console.log(`검증 결과: ${passed}/${checks.length} 통과`);
process.exit(passed === checks.length ? 0 : 1);
