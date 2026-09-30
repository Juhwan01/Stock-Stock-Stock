/**
 * 용도별 모델 라우팅 — 지정하지 않으면 Codex 기본값(최상위 모델)으로 돌아, 사용자의 코딩과 같은 ChatGPT 구독 한도를 빨리 쓴다.
 * 품질이 필요한 곳에만 상위 모델을 쓴다.
 *
 * 우선순위: codex 인자 -m > 환경 변수 SSS_<용도>_MODEL·_EFFORT (한 번만 바꿀 때) > 설정 파일(대화의 model_settings) > 기본값
 * 설정 파일은 레포의 var/ 에 둔다 — 에이전트의 쓰기 범위(wiki/) 밖이라 승인을 거친 도구로만 바뀐다
 */
import { spawnSync } from 'node:child_process';
import { readSettings, updateSettings, SETTINGS_FILE } from './settings.mjs';

export { readSettings, SETTINGS_FILE };

/** 이름은 `codex debug models` 목록에서 골랐다 (2026-09-27). doctor·model_settings 가 목록과 대조한다 */
export const ROUTES = {
  chat: { model: 'gpt-6-sol', effort: 'medium', what: '대화 리서치 (sss)' },
  deep: { model: 'gpt-6-astra', effort: 'high', what: '판단 기록·복기 (sss deep)' },
  exec: { model: 'gpt-6-luna', effort: 'medium', what: '비대화 실행 (sss exec · E2E)' },
  briefing: { model: 'gpt-6-luna', effort: 'medium', what: '아침 브리핑 분류·해석' },
  // 장중에 여러 번 돈다 — 공시 한두 건을 읽고 몇 줄로 요약하는 일이라 가장 가볍게
  watch: { model: 'gpt-6-luna', effort: 'low', what: '장중 감시 알림 해석' },
};

/** CODEX_API_KEY 가 있으면 codex 가 조용히 API 과금으로 넘어간다 */
const codexEnv = () => {
  const env = { ...process.env };
  delete env.CODEX_API_KEY;
  return env;
};

/** { model, effort, source } — source 는 값이 어디서 왔는지 (default · settings · env) */
export function resolveRoute(route, { env = process.env, settings = readSettings() } = {}) {
  const k = route.toUpperCase();
  const saved = settings.models?.[route] ?? {};
  const pick = (field, envKey) =>
    env[envKey] ? [env[envKey], 'env'] : typeof saved[field] === 'string' && saved[field] ? [saved[field], 'settings'] : [ROUTES[route][field], 'default'];
  const [model, ms] = pick('model', `SSS_${k}_MODEL`);
  const [effort, es] = pick('effort', `SSS_${k}_EFFORT`);
  return { model, effort, source: [ms, es].includes('env') ? 'env' : [ms, es].includes('settings') ? 'settings' : 'default' };
}

/**
 * -m · model_reasoning_effort 인자. 사용자가 codex 인자로 직접 준 값은 덮지 않는다 — codex 는 -m 이 두 번 오면 거부하고,
 * CLI -m 은 -c model= 보다 우선이라 덮으면 사용자의 선택이 조용히 사라진다. 모델을 직접 골랐으면 추론 강도도
 * 그 모델의 기본값에 맡긴다 (용도의 강도를 그 모델이 지원하지 않을 수 있다). `--` 뒤는 프롬프트라 보지 않는다
 */
export function modelArgs({ model, effort }, userArgs = []) {
  const end = userArgs.indexOf('--');
  const args = end < 0 ? userArgs : userArgs.slice(0, end);
  const cfg = args.flatMap((a, i) => {
    if (a === '-c' || a === '--config') return [args[i + 1] ?? ''];
    if (a.startsWith('--config=')) return [a.slice(9)];
    if (/^-c./.test(a)) return [a.slice(2).replace(/^=/, '')]; // -cmodel=x · -c=model=x
    return [];
  });
  const sets = (key) => cfg.some((c) => new RegExp(`^\\s*${key}\\s*=`).test(c));
  const userModel = args.some((a) => a === '--model' || a.startsWith('--model=') || /^-m/.test(a)) || sets('model');
  const userEffort = userModel || sets('model_reasoning_effort');
  return [...(userModel ? [] : ['-m', model]), ...(userEffort ? [] : ['-c', `model_reasoning_effort=${JSON.stringify(effort)}`])];
}

/** Codex 가 쓸 수 있는 모델 → 지원 추론 강도. 모델 호출 없음. 못 받으면 null */
export function codexModels() {
  const r = spawnSync('codex', ['debug', 'models'], { encoding: 'utf8', env: codexEnv(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });
  if (r.error || r.status !== 0) return null;
  try {
    // 디버그 출력이라 형식이 바뀔 수 있다 — 강도 목록을 못 읽으면 빈 배열(= 강도는 확인 못 함)
    return new Map(JSON.parse(r.stdout).models.map((m) => [m.slug, (m.supported_reasoning_levels ?? []).map((l) => (typeof l === 'string' ? l : l?.effort)).filter(Boolean)]));
  } catch {
    return null;
  }
}

/** 목록과 대조한 문제 한 줄, 없으면 null */
export function routeProblem({ model, effort }, catalog) {
  if (!catalog) return 'codex 모델 목록을 받지 못해 확인 못 함';
  const efforts = catalog.get(model);
  if (!efforts) return `codex 목록에 없는 모델: ${model} (있는 것: ${[...catalog.keys()].join(', ')})`;
  if (efforts.length && !efforts.includes(effort)) return `${model} 는 추론 강도 ${effort} 를 지원하지 않음 (${efforts.join('/')})`;
  return null;
}

/**
 * 용도의 모델·강도를 바꾸거나(reset 이면 기본값으로) 저장한다. 목록에 없는 값은 저장하지 않는다 —
 * 무인 브리핑이 틀린 이름으로 돌면 원자료만 남는다
 */
export function updateRoute({ route, model, effort, reset = false }, { file = SETTINGS_FILE, catalog = codexModels() } = {}) {
  if (!ROUTES[route]) throw new Error(`알 수 없는 용도: ${route} (${Object.keys(ROUTES).join(' · ')})`);
  const settings = readSettings(file);
  const models = { ...(settings.models ?? {}) };
  if (reset) delete models[route];
  else {
    if (!model && !effort) throw new Error('model 이나 effort 중 하나는 준다 (기본값으로 되돌리려면 reset)');
    const next = { ...resolveRoute(route, { env: {}, settings }), ...(model && { model }), ...(effort && { effort }) };
    const problem = routeProblem(next, catalog);
    if (problem) throw new Error(problem);
    models[route] = { model: next.model, effort: next.effort };
  }
  updateSettings((cur) => ({ ...cur, models }), file);
  return { route, ...resolveRoute(route, { env: {}, settings: { models } }), default: { model: ROUTES[route].model, effort: ROUTES[route].effort } };
}

/** 대화·상태 점검용 표 — 지금 쓰는 값, 기본값, 목록 대조 결과 */
export function routeTable({ env = process.env, settings = readSettings(), catalog } = {}) {
  return Object.entries(ROUTES).map(([route, r]) => {
    const cur = resolveRoute(route, { env, settings });
    return { route, what: r.what, model: cur.model, effort: cur.effort, source: cur.source, default: `${r.model} · ${r.effort}`, ...(catalog !== undefined && { problem: routeProblem(cur, catalog) }) };
  });
}
