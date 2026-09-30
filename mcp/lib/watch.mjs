/**
 * 상시 감시 (PLAN.md M3) — 항상 켜둔 맥에서 launchd 로 상주하는 모델 없는 폴러
 *
 *  - 코드가 새 공시·뉴스를 가져와 보유·관심 종목·열린 판단의 대상과 규칙으로 맞춘다. 걸린 것만 텔레그램으로 민다
 *  - 모델은 걸린 공시(기계적 공시 제외)만 해석한다: 몇 건을 모아 codex exec 한 번, 하루 횟수 한도 안에서.
 *    원문 알림은 모델을 기다리지 않고 먼저 간다 — 해석은 뒤따르는 두 번째 메시지다
 *  - 뉴스는 모델에 넘기지 않는다 — 언론사 약관(비상업·개인, 연합뉴스 "AI 활용 금지")과 알림 피로 때문
 *  - 상태·알림 기록은 레포의 var/watch/ 에 둔다 — 에이전트의 쓰기 범위(wiki/) 밖이라 감시 기록을 고칠 수 없다
 *  - 빠른 길(시장 전체 목록 20초)과 빈틈 메우기(종목별 점검 10분)를 같이 돈다. 맥이 잠들었다 깨면 공백을 기록하고
 *    바로 종목별 점검을 돌려 따라잡는다. 그래도 빠진 것은 다음 날 아침 브리핑이 종목별로 다시 모은다
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dartLatest, edgarCurrent, fetchRss, NEWS_FEEDS } from './feeds.mjs';
import { acquireRunLock, ROUTINE_KR, ROUTINE_US } from './briefing.mjs';
import { openDecisions } from './decision.mjs';
import { readPortfolio, universe } from './portfolio.mjs';
import { readSettings, updateSettings, SETTINGS_FILE } from './settings.mjs';
import { addDays, kstDate, kstParts, kstStamp, kstTime } from './store.mjs';

export const WATCH_DIR = 'watch';
const STATE = 'state.json';
const STOP = 'stop-requested';
const ALERTS = /^alerts-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export const WATCH_DEFAULTS = { news: 'holdings', interpret: true, llm_daily_cap: 10, keep_awake: true };
export const NEWS_MODES = ['holdings', 'all', 'off'];

const TICK_MS = 5e3;
const GAP_MS = 120e3; // 틱이 이만큼 끊기면 잠자기·중단으로 본다
const GAP_NOTIFY_MIN = 10;
const HEARTBEAT_MS = 30e3;
const BEAT_MS = 10e3; // 이벤트 루프 박동 — 이 타이머가 GAP_MS 넘게 늦으면 프로세스가 멈춰 있던 것(잠자기)
const STALE_MS = 3 * 60e3; // 이보다 오래 소식이 없으면 감시가 멈춘 것
const BATCH_WAIT_MS = 60e3; // 해석은 잠깐 모았다가 한 번에
const BATCH_MAX = 5;
// DART 원문은 목록보다 늦게 열린다 (2026-09-30 실측) — 열릴 때까지 해석을 미루고, 너무 오래 안 열리면 해석을 건너뛴다
const DOC_RECHECK_MS = 60e3; // 첫 재확인. 이후 2배씩 32분까지 — 두 시간에 8번 남짓
const DOC_WAIT_MAX_MS = 120 * 60e3;
const SWEEP_MAX = 40; // 시장마다 종목별 점검 상한 — 10분마다 종목당 DART 한 번
const PUSH_EACH_MAX = 5; // 한 번에 이보다 많이 걸리면 한 통으로 묶는다
const NEWS_COOLDOWN_MS = 20 * 60e3;
const NEWS_MAX_AGE_MS = 3 * 3600e3; // 따라잡기로 들어온 오래된 뉴스는 기록만
const KEEP_DAYS = 30;
const TARGETS_TTL_MS = 15e3;
const EDGAR_UA = 'Stock-Stock-Stock-personal-research contact-not-set@example.com';

// ── 설정 ─────────────────────────────────────────────────────────
export function watchSettings(settings = readSettings()) {
  const s = settings.watch ?? {};
  return {
    news: NEWS_MODES.includes(s.news) ? s.news : WATCH_DEFAULTS.news,
    interpret: typeof s.interpret === 'boolean' ? s.interpret : WATCH_DEFAULTS.interpret,
    llm_daily_cap: Number.isInteger(s.llm_daily_cap) && s.llm_daily_cap >= 0 && s.llm_daily_cap <= 50 ? s.llm_daily_cap : WATCH_DEFAULTS.llm_daily_cap,
    keep_awake: typeof s.keep_awake === 'boolean' ? s.keep_awake : WATCH_DEFAULTS.keep_awake,
  };
}

export function updateWatchSettings(patch, file = SETTINGS_FILE) {
  const clean = Object.fromEntries(Object.entries(patch).filter(([k, v]) => k in WATCH_DEFAULTS && v !== undefined));
  if ('news' in clean && !NEWS_MODES.includes(clean.news)) throw new Error(`news 는 ${NEWS_MODES.join(' · ')}`);
  if ('llm_daily_cap' in clean && !(Number.isInteger(clean.llm_daily_cap) && clean.llm_daily_cap >= 0 && clean.llm_daily_cap <= 50)) throw new Error('llm_daily_cap 은 0~50');
  const next = updateSettings((s) => ({ ...s, watch: { ...watchSettings(s), ...clean } }), file);
  return watchSettings(next);
}

// ── 대상: 보유 · 관심 · 열린 판단의 대상 ─────────────────────────
const keyOf = (x) => `${x.market}:${x.code}`;

/** [{ market, code, name, role, weight, decisions: [{ id, title, invalidation_condition }] }] — 보유(비중 순) · 관심 · 판단 대상 */
export function watchTargets({ portfolio, db }) {
  const out = universe(portfolio).map((u) => ({ ...u, decisions: [] }));
  const byKey = new Map(out.map((t) => [keyOf(t), t]));
  if (db) {
    const about = db.prepare(`SELECT n.id, n.title, n.ticker FROM edges e JOIN nodes n ON n.id = e.dst WHERE e.src = ? AND e.rel = 'about' AND n.ticker IS NOT NULL`);
    for (const d of openDecisions(db)) {
      for (const n of about.all(d.id)) {
        const ticker = String(n.ticker).trim();
        const market = /^\d{6}$/.test(ticker) ? 'KR' : 'US';
        const code = market === 'US' ? ticker.toUpperCase() : ticker;
        let t = byKey.get(`${market}:${code}`);
        if (!t) {
          t = { market, code, name: n.title, role: 'decision', weight: null, decisions: [] };
          byKey.set(keyOf(t), t);
          out.push(t);
        }
        t.decisions.push({ id: d.id, title: d.title, invalidation_condition: d.decision.invalidation_condition ?? null });
      }
    }
  }
  return out;
}

// ── 규칙 매칭 ────────────────────────────────────────────────────
const base = (t) => ({ market: t.market, code: t.code, name: t.name, role: t.role, weight: t.weight, decisions: t.decisions });

/** DART 목록 항목 → 대상 종목의 알림 */
export function matchDart(items, targets) {
  const kr = new Map(targets.filter((t) => t.market === 'KR').map((t) => [t.code, t]));
  return items
    .filter((i) => i.stock_code && kr.has(i.stock_code))
    .map((i) => ({
      id: i.id, kind: 'filing', source: 'DART', ...base(kr.get(i.stock_code)), date: i.date, title: i.title, url: i.url,
      hint: ROUTINE_KR.some((re) => re.test(i.title)) ? 'routine' : null,
    }));
}

/** EDGAR getcurrent 줄 → 대상 종목의 알림. 한 공시가 역할마다 여러 줄이라 접수번호로 묶는다 */
export function matchEdgar(entries, cikTargets) {
  const out = new Map();
  for (const e of entries) {
    const t = cikTargets.get(e.cik);
    const id = `sec:${e.accession}`;
    if (!t || out.has(id)) continue;
    out.set(id, {
      id, kind: 'filing', source: 'SEC', ...base(t), date: e.updated.slice(0, 10), title: `${e.form} — ${e.company}`, form: e.form, url: e.url,
      hint: ROUTINE_US.has(e.form) ? 'routine' : null,
    });
  }
  return [...out.values()];
}

const norm = (s) => String(s).toLowerCase().replace(/[\s·.,'"‘’“”()\[\]]/g, '');

/** 뉴스 제목에 종목 이름(공백 무시)이나 미국 티커(3자 이상, 단어 경계)가 있으면 알림 */
export function matchNews(items, targets) {
  const out = [];
  for (const n of items) {
    const title = norm(n.title);
    for (const t of targets) {
      const name = norm(t.name);
      const byName = name.length >= 2 && title.includes(name);
      const byTicker = t.market === 'US' && t.code.length >= 3 && new RegExp(`(^|[^A-Za-z])${t.code.replace(/[.-]/g, '\\$&')}([^A-Za-z]|$)`).test(n.title);
      if (!byName && !byTicker) continue;
      out.push({
        id: `news:${n.link}:${keyOf(t)}`, kind: 'news', source: n.source, ...base(t), date: n.published ? kstDate(new Date(n.published)) : null,
        published: n.published, title: n.title, url: n.link, hint: null,
      });
    }
  }
  return out;
}

// ── 알림 글 ──────────────────────────────────────────────────────
const ROLE = { holding: '보유', watch: '관심', decision: '판단 대상' };
const roleLabel = (a) => `${ROLE[a.role] ?? a.role}${a.role === 'holding' && a.weight != null ? ` ${(a.weight * 100).toFixed(0)}%` : ''}`;

/** 공시 한 건 → { title, text } (평문) */
export function filingMessage(a, at = new Date()) {
  const lines = [`${a.source} · ${a.date} · ${kstTime(at)} 감지`, a.url];
  for (const d of a.decisions ?? []) lines.push(`⚠ 열린 판단 ${d.id} 의 대상 — 무효화 조건: ${d.invalidation_condition ?? '(없음)'}`);
  return { title: `🔔 [${roleLabel(a)}] ${a.name} — ${a.title}`, text: lines.join('\n') };
}

/** 여러 건을 한 통으로 */
export function digestMessage(alerts, at = new Date()) {
  const lines = alerts.map((a) => `· [${roleLabel(a)}] ${a.name} — ${a.title}${a.decisions?.length ? ' ⚠열린 판단' : ''}\n  ${a.url}`);
  return { title: `🔔 공시 ${alerts.length}건 (${kstTime(at)} 감지)`, text: lines.join('\n') };
}

/** 한 종목의 뉴스 묶음 */
export function newsMessage(alerts, { suppressed = 0 } = {}) {
  const a = alerts[0];
  const lines = alerts.map((x) => `· ${x.title} (${x.source})\n  ${x.url}`);
  if (suppressed) lines.push(`(직전 20분 사이 ${suppressed}건은 묶어서 건너뜀 — 대화에서 "오늘 알림 보여줘")`);
  return { title: `📰 [${roleLabel(a)}] ${a.name} — 뉴스 ${alerts.length}건`, text: lines.join('\n') };
}

// ── 파일: 상태 · 알림 기록 · 잠금 · 로그 ─────────────────────────
export const watchDir = (varDir) => {
  const d = join(varDir, WATCH_DIR);
  mkdirSync(d, { recursive: true });
  return d;
};

export function readWatchState(varDir) {
  try {
    const s = JSON.parse(readFileSync(join(varDir, WATCH_DIR, STATE), 'utf8'));
    return s && typeof s === 'object' ? s : {};
  } catch {
    return {};
  }
}

function writeWatchState(varDir, state) {
  const file = join(watchDir(varDir), STATE);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}

const alertsFile = (varDir, day) => join(watchDir(varDir), `alerts-${day}.jsonl`);

export function appendRecord(varDir, rec, at = new Date()) {
  appendFileSync(alertsFile(varDir, kstDate(at)), `${JSON.stringify({ at: at.toISOString(), ...rec })}\n`);
}

function pruneRecords(varDir, today) {
  const cutoff = addDays(today, -KEEP_DAYS);
  for (const f of readdirSync(watchDir(varDir))) {
    const m = f.match(ALERTS);
    if (m && m[1] < cutoff) rmSync(join(varDir, WATCH_DIR, f), { force: true });
  }
}

/** 한 날짜의 기록 (날짜는 KST 감지일) */
export function readRecords(varDir, day) {
  const file = join(varDir, WATCH_DIR, `alerts-${day}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => {
    try {
      return [JSON.parse(l)];
    } catch {
      return [];
    }
  });
}

/**
 * 대화·해석용 조회. batch 를 주면 그 해석 묶음의 항목만(날짜는 묶음 이름에서).
 * 항목의 제목은 외부 데이터다 — 도구 설명에도 적는다
 */
export function queryAlerts(varDir, { date, batch, kind, limit = 30 } = {}) {
  if (batch) {
    const day = batch.slice(0, 10);
    // 자정 직전에 걸린 항목은 전날 파일에 있다
    const recs = [...readRecords(varDir, addDays(day, -1)), ...readRecords(varDir, day)];
    const b = recs.find((r) => r.type === 'batch' && r.batch === batch);
    if (!b) throw new Error(`해석 묶음이 없음: ${batch}`);
    const ids = new Set(b.ids);
    return { batch, items: recs.filter((r) => r.type === 'alert' && ids.has(r.id)) };
  }
  const day = date ?? kstDate();
  const recs = readRecords(varDir, day);
  // 뉴스는 제목 없이 — 언론사 약관상 모델에 넘기지 않는다 (기록에도 남기지 않지만 예전 기록까지 막는다)
  const alerts = recs.filter((r) => r.type === 'alert' && (!kind || r.kind === kind)).map((r) => (r.kind === 'news' ? (({ title, ...x }) => x)(r) : r));
  return {
    date: day,
    total: alerts.length,
    pushed: alerts.filter((a) => a.push === 'telegram' || a.push === 'mac').length,
    note: '뉴스 알림은 제목 없이 링크만 준다 — 제목은 사용자의 텔레그램에 있다',
    alerts: alerts.slice(-limit).reverse(),
    interpretations: recs.filter((r) => r.type === 'interpretation').slice(-5).reverse(),
    gaps: recs.filter((r) => r.type === 'gap'),
  };
}

/** 브리핑의 "먼저 볼 것"용 — since(YYYY-MM-DD)부터 오늘까지의 알림 수와 감시 공백 */
export function watchDigest(varDir, since, today = kstDate()) {
  const st = readWatchState(varDir);
  if (!st.started_at) return null; // 감시를 켠 적이 없다
  let alerts = 0;
  let pushed = 0;
  const gaps = [];
  for (let d = since; d <= today; d = addDays(d, 1)) {
    for (const r of readRecords(varDir, d)) {
      if (r.type === 'alert' && !r.reason) {
        alerts++; // 기준선·기계적 공시처럼 규칙상 안 보낸 것은 세지 않는다
        if (r.push === 'telegram' || r.push === 'mac') pushed++;
      } else if (r.type === 'gap') gaps.push({ from: r.from, to: r.to, minutes: r.minutes });
    }
  }
  const seen = Math.max(st.alive ?? 0, st.last_tick ?? 0);
  return { alerts, pushed, gaps, running: !!seen && Date.now() - seen < STALE_MS, last_seen: seen ? kstStamp(new Date(seen)) : null };
}

const alive = (pid) => {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code !== 'ESRCH';
  }
};

/**
 * 감시는 하나만 돈다 (launchd 와 손으로 띄운 것이 겹치지 않게) — 브리핑과 같은 잠금 구현(동시 경쟁 검증됨).
 * 쥔 쪽은 심장 박동마다 release.refresh() 로 갱신한다 — 3분 넘게 갱신이 없으면 멈춘 감시로 보고 넘겨받는다
 */
export const acquireWatchLock = (varDir) => acquireRunLock(watchDir(varDir), varDir, { kind: 'watch', staleMs: STALE_MS });

/** 감시 로그 — 폴링마다가 아니라 일이 있을 때만 쓴다. 5MB 넘으면 한 번 돌린다 */
export function watchLogger(varDir, { echo = false } = {}) {
  const file = join(varDir, 'watch.log');
  return (msg) => {
    const line = `[watch ${kstStamp()}] ${msg}`;
    if (echo) console.log(line);
    try {
      mkdirSync(varDir, { recursive: true });
      if (existsSync(file) && statSync(file).size > 5 << 20) renameSync(file, `${file}.1`);
      appendFileSync(file, `${line}\n`);
    } catch {}
  };
}

/** 상태 점검용 요약 — 실행 여부는 최근 틱(심장 박동)과 pid 로 판단한다 */
export function watchStatus(varDir, { settings = readSettings(), agent = null } = {}) {
  const st = readWatchState(varDir);
  const cfg = watchSettings(settings);
  const today = kstDate();
  const recs = readRecords(varDir, today);
  const alerts = recs.filter((r) => r.type === 'alert');
  const seen = Math.max(st.alive ?? 0, st.last_tick ?? 0);
  const fresh = !!seen && Date.now() - seen < STALE_MS;
  return {
    registered: agent?.registered ?? null,
    running: fresh && alive(st.pid),
    pid: fresh ? st.pid ?? null : null,
    started_at: st.started_at ?? null,
    last_seen: seen ? kstStamp(new Date(seen)) : null,
    targets: st.targets ?? null,
    sources: st.sources ?? {},
    today: {
      alerts: alerts.filter((a) => !a.reason).length,
      pushed: alerts.filter((a) => a.push === 'telegram' || a.push === 'mac').length,
      interpretations: recs.filter((r) => r.type === 'interpretation').length,
      gaps: recs.filter((r) => r.type === 'gap').map((g) => ({ from: g.from, to: g.to, minutes: g.minutes })),
    },
    llm: { used_today: st.llm?.date === today ? st.llm.used : 0, daily_cap: cfg.llm_daily_cap, interpret: cfg.interpret },
    settings: cfg,
  };
}

// ── 주기 (KST) ───────────────────────────────────────────────────
/** 소스별 폴링 간격(ms). DART 는 평일 07~20시에 20초, 그 밖엔 5분. 미국은 한국 밤이 장이라 늘 1분 */
export function cadence(source, t) {
  const { weekday, hour } = kstParts(new Date(t));
  const busy = weekday >= 1 && weekday <= 5 && hour >= 7 && hour < 20;
  switch (source) {
    case 'dart': return busy ? 20e3 : 300e3;
    case 'dart_sweep': return busy ? 600e3 : 3600e3;
    case 'edgar': return 60e3;
    case 'edgar_sweep': return 1800e3;
    case 'news': return hour >= 6 ? 180e3 : 900e3;
    default: throw new Error(`알 수 없는 소스: ${source}`);
  }
}

// ── 감시기 ───────────────────────────────────────────────────────
/** 사용자가 끈 것(watch_control stop · sss watch uninstall)과 종료·로그아웃의 SIGTERM 을 구별하는 표시 — 끄기 직전에 남긴다 */
export function requestStop(varDir) {
  writeFileSync(join(watchDir(varDir), STOP), String(Date.now()));
}

/**
 * @param root      위키 루트 (portfolio.yaml · pages/)
 * @param varDir    상태·기록 위치 (레포 var/)
 * @param env       데이터 키 (.env) — DART_API_KEY · EDGAR_UA · TELEGRAM_BOT_TOKEN
 * @param wiki      createWiki(...) — 열린 판단의 대상
 * @param dart      createDart(...) — 종목별 점검 · 원문 열림 확인
 * @param edgar     { recentFilings(ticker, n), cikOf(ticker) } — 종목별 점검·CIK
 * @param notify    async ({ title, text, silent, fallback }) → { via, error?, retryAfter? } — fallback=false 면 macOS 대체 알림을 띄우지 않는다
 * @param interpret async ({ batch, items }) → { code, text, model } — 없으면 해석하지 않는다
 * @param now       벽시계(ms)
 * @param dryRun    알림·기록·상태를 쓰지 않고 로그로만 (상태는 읽는다 — 실제로 무엇이 갈지 보인다)
 * @param keepAwake (on) => void — 틱마다 설정의 keep_awake 를 넘긴다 (잠자기 막기는 실행기가 한다)
 * @param heartbeat () => boolean — 상태를 저장할 때마다·알림을 보내기 직전에 (잠금 갱신). false 면 잠금을 잃은 것 — 다른 감시가 넘겨받았다
 * @param startupGap 새로 뜰 때 직전 감시와의 공백을 볼지 — 손으로 한 바퀴 돌리는 sss watch once 는 끈다 (상주 감시가 아니다)
 */
export function createWatcher({ root, varDir, env = {}, wiki, dart, edgar, fetch = globalThis.fetch, now = () => Date.now(), notify, interpret = null, log = () => {}, dryRun = false, settingsFile = SETTINGS_FILE, feeds = NEWS_FEEDS, keepAwake = null, heartbeat = null, startupGap = true }) {
  const state = readWatchState(varDir);
  state.alerted ??= {};
  state.sources ??= {};
  state.baseline ??= {};
  state.baseline_targets ??= {};
  state.gaps ??= [];
  // 직전 감시의 마지막 소식 — 첫 저장이 덮기 전에 잡아 둔다 (코드 리뷰: run() 의 첫 저장이 이 값을 지금으로 바꿔 공백이 사라졌다)
  const lastSeen = Math.max(state.alive ?? 0, state.last_tick ?? 0);
  const mem = {
    seen: { dart: new Set(), edgar: new Set(), news: new Set() },
    nextAt: {},
    queue: [],
    interpreting: null,
    outbox: [],
    cooldown: new Map(),
    suppressed: new Map(),
    ciks: new Map(), // ticker → cik (한 번 찾으면 둔다)
    targets: [],
    targetsAt: 0,
    lastSave: 0,
    started: false, // 첫 틱을 돌았는가 — 시작 공백 판정은 한 번
    lastBeat: null, // 이벤트 루프 박동 — 잠자기 판정용
    pendingGap: null,
    failures: {}, // 소스별 연속 실패 — 재시도 간격을 늘린다
    capNoticeDay: null,
    pruneDay: null,
    lockLost: false,
    tooMany: false,
  };

  /** 아직 잠금을 쥐고 있는가 — 갱신도 겸한다. 잃었으면 이 감시는 더 보내거나 쓰지 않는다 */
  const owner = () => {
    if (mem.lockLost) return false;
    if (heartbeat && heartbeat() === false) {
      mem.lockLost = true;
      log('잠금을 잃었다 — 다른 감시가 넘겨받았다. 이 감시는 끝낸다');
    }
    return !mem.lockLost;
  };
  const save = (force = false) => {
    if (dryRun || mem.lockLost) return; // 잠금을 잃었으면 상태는 넘겨받은 감시의 것이다
    const t = now();
    if (!force && t - mem.lastSave < HEARTBEAT_MS) return;
    mem.lastSave = t;
    if (!owner()) return; // 잠금부터 갱신한다 — 넘겨받혔으면 한 번도 쓰지 않고 멈춘다
    state.alive = t;
    // 알림을 보낸 id 는 7일만 둔다 — 종목별 점검은 어제·오늘만 본다
    const cutoff = addDays(kstDate(new Date(t)), -7);
    for (const [k, d] of Object.entries(state.alerted)) if (d < cutoff) delete state.alerted[k];
    state.gaps = state.gaps.slice(-20);
    writeWatchState(varDir, state);
  };
  const record = (rec) => {
    if (mem.lockLost) return; // 넘겨받은 감시가 기록한다
    if (!dryRun) return appendRecord(varDir, rec, new Date(now()));
    if (rec.type === 'alert') log(`[dry-run] 알림 ${rec.push ?? 'none'}${rec.reason ? ` (${rec.reason})` : ''} · ${rec.name} — ${rec.title ?? rec.url}`);
  };
  const srcOk = (name, extra = {}) => (state.sources[name] = { last_ok: kstStamp(new Date(now())), last_error: null, ...extra });
  const srcFail = (name, e) => {
    const prev = state.sources[name]?.last_error;
    state.sources[name] = { ...state.sources[name], last_error: e.message, error_at: kstStamp(new Date(now())) };
    if (prev !== e.message) log(`${name} 실패: ${e.message}`); // 같은 오류는 한 번만 적는다
  };

  function loadTargets(t) {
    if (t - mem.targetsAt < TARGETS_TTL_MS) return mem.targets;
    mem.targetsAt = t;
    try {
      const db = wiki?.get().db;
      mem.targets = watchTargets({ portfolio: readPortfolio(root), db });
    } catch (e) {
      // 포트폴리오를 고치는 중이면 직전 대상으로 계속 본다
      if (mem.targetsError !== e.message) log(`대상 읽기 실패 (직전 대상 유지): ${e.message}`);
      mem.targetsError = e.message;
      return mem.targets;
    }
    mem.targetsError = null;
    // 대상에서 빠진 종목의 기준선 표시는 지운다 — 다시 넣으면 다시 기준선 (시장의 마지막 종목을 빼 점검이 꺼져도)
    const keys = new Set(mem.targets.map(keyOf));
    for (const bt of Object.values(state.baseline_targets)) for (const k of Object.keys(bt)) if (!keys.has(k)) delete bt[k];
    state.targets = { KR: mem.targets.filter((x) => x.market === 'KR').length, US: mem.targets.filter((x) => x.market === 'US').length };
    return mem.targets;
  }

  /** 종목별 점검 대상 — 시장마다 앞에서부터(보유 비중 순) SWEEP_MAX 개. 위키에 종목을 잔뜩 심어 DART 한도를 태우지 못하게 */
  function sweepTargets(market) {
    const all = mem.targets.filter((x) => x.market === market);
    if (all.length > SWEEP_MAX && !mem.tooMany) {
      mem.tooMany = true;
      log(`${market} 대상 ${all.length}개 — 종목별 점검은 앞 ${SWEEP_MAX}개만 (빠른 길은 전부 본다)`);
    }
    return all.slice(0, SWEEP_MAX);
  }

  // ── 알림 보내기 ──
  async function send(msg) {
    if (mem.lockLost) return { via: null }; // 넘겨받은 감시가 보낸다 — 두 번 가지 않게
    if (dryRun) {
      log(`[dry-run] ${msg.title}\n${msg.text}`);
      return { via: 'dry-run' };
    }
    const r = await notify(msg);
    if (!r.via && r.error) {
      mem.outbox.push({ msg, attempts: 1, nextAt: now() + Math.max(30e3, (r.retryAfter ?? 0) * 1e3) });
      log(`알림 실패 — 다시 보낸다: ${r.error}`);
      return { via: null, retrying: true };
    }
    return r;
  }

  async function flushOutbox() {
    const t = now();
    for (const o of [...mem.outbox]) {
      if (o.nextAt > t) continue;
      // 첫 실패 때 이미 macOS 로 알렸다 — 재시도마다 다시 띄우지 않는다
      const r = await notify({ ...o.msg, fallback: false });
      if (r.via) {
        mem.outbox.splice(mem.outbox.indexOf(o), 1);
        log(`다시 보냄: ${o.msg.title}`);
      } else if (++o.attempts >= 6) {
        mem.outbox.splice(mem.outbox.indexOf(o), 1);
        log(`알림 포기 (6회 실패): ${o.msg.title} — ${r.error}`);
      } else {
        o.nextAt = t + Math.max(30e3 * 2 ** o.attempts, (r.retryAfter ?? 0) * 1e3);
      }
    }
  }

  // none 은 규칙상 안 보낸 것(reason 이 붙는다). no-channel 은 보내려 했지만 받을 곳이 없던 것(텔레그램 미연결 + macOS 알림 불가)
  const pushLabel = (r) => (r.via ?? (r.retrying ? 'retrying' : 'no-channel'));

  /**
   * 새 공시 알림. 기준선(a.baseline — 소스를 처음 돌거나 종목을 새로 넣은 첫 점검)이면 기록만, 기계적 공시도 기록만, 나머지는 민다.
   * 기록한 즉시 상태를 저장한다 — 보낸 뒤 30초 안에 죽으면 다시 뜬 감시가 같은 알림을 또 보낸다 (코드 리뷰)
   */
  async function deliverFilings(alerts) {
    const byId = new Map();
    for (const a of alerts) if (!state.alerted[a.id] && !byId.has(a.id)) byId.set(a.id, a); // 한 폴링 안의 중복도 뺀다
    const fresh = [...byId.values()];
    if (!fresh.length || !owner()) return; // 보내기 직전에 잠금 확인 — 넘겨받은 감시와 겹쳐 두 번 가지 않게
    const t = new Date(now());
    const { hour } = kstParts(t);
    const quiet = hour < 7 || hour >= 22;
    const toPush = fresh.filter((a) => !a.baseline && a.hint !== 'routine');
    let result = { via: 'none' };
    if (toPush.length > PUSH_EACH_MAX) {
      result = await send({ ...digestMessage(toPush, t), silent: quiet });
    } else {
      for (const a of toPush) a.push = pushLabel(await send({ ...filingMessage(a, t), silent: quiet }));
    }
    for (const { baseline, ...a } of fresh) {
      const pushed = !baseline && a.hint !== 'routine';
      a.push ??= pushed ? pushLabel(result) : 'none';
      const reason = baseline ? 'baseline' : a.hint === 'routine' ? 'routine' : undefined;
      record({ type: 'alert', ...a, ...(reason && { reason }) });
      state.alerted[a.id] = kstDate(t);
      if (pushed) {
        log(`알림 ${a.push}: ${a.name} — ${a.title}`);
        if (interpret) mem.queue.push({ ...a, queuedAt: now() });
      }
    }
    save(true);
  }

  /** 뉴스 — 제목은 텔레그램으로만 가고 기록에는 남기지 않는다 (대화의 모델이 읽지 못하게 — 언론사 약관) */
  async function deliverNews(alerts, mode) {
    const t = now();
    const byId = new Map();
    for (const a of alerts) if (!state.alerted[a.id] && !byId.has(a.id)) byId.set(a.id, a);
    const fresh = [...byId.values()];
    if (!fresh.length || !owner()) return;
    const byTarget = new Map();
    for (const a of fresh) {
      const key = `${a.market}:${a.code}`;
      const eligible = !a.baseline && (mode === 'all' || a.role !== 'watch') && (!a.published || t - Date.parse(a.published) < NEWS_MAX_AGE_MS);
      const cooling = (mem.cooldown.get(key) ?? 0) > t;
      if (eligible && !cooling) {
        if (!byTarget.has(key)) byTarget.set(key, []);
        byTarget.get(key).push(a);
      } else {
        a.push = 'none';
        if (eligible && cooling) mem.suppressed.set(key, (mem.suppressed.get(key) ?? 0) + 1);
      }
    }
    for (const [key, xs] of byTarget) {
      const r = await send({ ...newsMessage(xs.slice(0, 8), { suppressed: mem.suppressed.get(key) ?? 0 }), silent: true });
      mem.cooldown.set(key, t + NEWS_COOLDOWN_MS);
      mem.suppressed.delete(key);
      for (const a of xs) a.push = pushLabel(r);
    }
    const day = kstDate(new Date(t));
    for (const { baseline, title, ...a } of fresh) {
      record({ type: 'alert', ...a, ...(baseline && { reason: 'baseline' }) });
      state.alerted[a.id] = day;
    }
    save(true);
  }

  // ── 소스 ──
  async function pollDart(t) {
    const today = kstDate(new Date(t));
    const { items, truncated } = await dartLatest({ key: env.DART_API_KEY, from: addDays(today, -1), to: today, seen: mem.seen.dart, pages: mem.seen.dart.size ? 5 : 2, fetch });
    for (const i of items) mem.seen.dart.add(i.id);
    // 어제 이전 접수번호는 다시 오지 않는다
    const floor = addDays(today, -1).replace(/-/g, '');
    if (mem.seen.dart.size > 20000) for (const id of mem.seen.dart) if (id.slice(5, 13) < floor) mem.seen.dart.delete(id);
    if (truncated) mem.nextAt.dart_sweep = 0; // 목록을 다 못 넘겼다 — 종목별 점검으로 메운다
    const baseline = !state.baseline.dart;
    await deliverFilings(matchDart(items, mem.targets).map((a) => ({ ...a, baseline })));
    state.baseline.dart = true;
    srcOk('dart', { new_items: items.length });
  }

  /**
   * 종목별 점검(어제·오늘). 종목을 처음 보는 점검은 그 종목의 기준선이다 — 관심 종목을 새로 넣었다고 이틀 치 공시가 알림으로 오지 않게.
   * 한 종목이 실패해도(우선주·ETF 는 DART 상장사 목록에 없다) 나머지는 계속 본다
   */
  async function sweep(source, market, fetchTarget) {
    const seenTargets = (state.baseline_targets[source] ??= {});
    const targets = sweepTargets(market);
    const alerts = [];
    const errors = [];
    const fresh = [];
    for (const target of targets) {
      if (mem.lockLost) return;
      try {
        const got = await fetchTarget(target);
        const baseline = !seenTargets[keyOf(target)];
        alerts.push(...got.map((a) => ({ ...a, baseline })));
        fresh.push(keyOf(target));
      } catch (e) {
        errors.push(`${target.code} ${target.name}: ${e.message}`);
      }
    }
    await deliverFilings(alerts);
    for (const k of fresh) seenTargets[k] = true;
    if (errors.length && errors.length === targets.length) throw new Error(errors.join(' / '));
    srcOk(source, errors.length ? { target_errors: errors } : {});
  }

  const sweepDart = (t) => {
    const today = kstDate(new Date(t));
    return sweep('dart_sweep', 'KR', async (target) => {
      const r = await dart.filings(target.code, { from: addDays(today, -1).replace(/-/g, ''), to: today.replace(/-/g, ''), limit: 100, finalOnly: false });
      return matchDart(r.filings.map((f) => ({ id: `dart:${f.rcept_no}`, stock_code: target.code, date: f.date, title: f.title, url: f.url })), [target]);
    });
  };

  const sweepEdgar = (t) => {
    const since = addDays(kstDate(new Date(t)), -2); // 미국 날짜는 한국보다 하루 늦다
    return sweep('edgar_sweep', 'US', async (target) => {
      const r = await edgar.recentFilings(target.code, 20);
      return r.filings.filter((f) => f.filed >= since).map((f) => ({
        id: `sec:${f.accession}`, kind: 'filing', source: 'SEC', ...base(target), date: f.filed,
        title: `${f.form}${f.items ? ` (items ${f.items})` : ''} — ${r.company}`, form: f.form, url: f.url, hint: ROUTINE_US.has(f.form) ? 'routine' : null,
      }));
    });
  };

  async function cikTargets() {
    const map = new Map();
    for (const target of mem.targets.filter((x) => x.market === 'US')) {
      if (!mem.ciks.has(target.code)) {
        try {
          mem.ciks.set(target.code, (await edgar.cikOf(target.code)).cik);
        } catch (e) {
          log(`CIK 찾기 실패 ${target.code}: ${e.message}`);
          mem.ciks.set(target.code, null);
        }
      }
      const cik = mem.ciks.get(target.code);
      if (cik) map.set(cik, target);
    }
    return map;
  }

  async function pollEdgar() {
    const { entries, truncated } = await edgarCurrent({ ua: env.EDGAR_UA || EDGAR_UA, seen: mem.seen.edgar, pages: mem.seen.edgar.size ? 3 : 1, fetch });
    for (const e of entries) mem.seen.edgar.add(`sec:${e.accession}`);
    if (mem.seen.edgar.size > 20000) mem.seen.edgar = new Set([...mem.seen.edgar].slice(-5000));
    if (truncated) mem.nextAt.edgar_sweep = 0;
    const baseline = !state.baseline.edgar;
    await deliverFilings(matchEdgar(entries, await cikTargets()).map((a) => ({ ...a, baseline })));
    state.baseline.edgar = true;
    srcOk('edgar', { new_items: entries.length });
  }

  /** 피드마다 처음 성공한 폴링이 기준선이다 — 전부 실패한 첫 폴링 뒤에 세 시간 치 기사가 쏟아지지 않게 (코드 리뷰) */
  async function pollNews(mode) {
    const items = [];
    const baselineLinks = new Set();
    const errors = [];
    for (const feed of feeds) {
      const bkey = `news:${feed.url}`;
      try {
        const got = await fetchRss(feed, { fetch });
        for (const n of got) {
          if (mem.seen.news.has(n.link)) continue;
          mem.seen.news.add(n.link);
          items.push(n);
          if (!state.baseline[bkey]) baselineLinks.add(n.link);
        }
        state.baseline[bkey] = true;
      } catch (e) {
        errors.push(e.message);
      }
    }
    if (mem.seen.news.size > 5000) mem.seen.news = new Set([...mem.seen.news].slice(-2000));
    await deliverNews(matchNews(items, mem.targets).map((a) => ({ ...a, baseline: baselineLinks.has(a.url) })), mode);
    if (errors.length === feeds.length) throw new Error(errors.join(' / '));
    srcOk('news', { new_items: items.length, ...(errors.length && { feed_errors: errors }) });
  }

  // ── 해석 ──
  /**
   * 모인 공시를 해석한다. 순서: 모으는 시간(60초) → 하루 한도 → 원문이 열렸는지(코드가 확인, 모델 호출 없음) → 해석.
   * 원문이 안 열린 한국 공시는 항목마다 1분 뒤에 다시 보고(그 사이 다른 항목은 먼저 간다), DOC_WAIT_MAX 가 지나도 안 열리면
   * 해석을 건너뛴다 — 제목만으로 해석하면 한도만 쓴다.
   * force: 모으는 시간을 기다리지 않는다 (sss watch once --interpret-now)
   */
  function maybeInterpret(cfg, { force = false } = {}) {
    if (mem.interpreting || !mem.queue.length || mem.lockLost) return;
    const t = now();
    const due = mem.queue.filter((a) => (a.nextCheckAt ?? 0) <= t);
    if (!due.length) return;
    if (!force && due.length < BATCH_MAX && due.every((a) => t - a.queuedAt < BATCH_WAIT_MS)) return;
    const day = kstDate(new Date(t));
    if (state.llm?.date !== day) state.llm = { date: day, used: 0 };
    if (!cfg.interpret || state.llm.used >= cfg.llm_daily_cap) {
      if (cfg.interpret && cfg.llm_daily_cap > 0 && mem.capNoticeDay !== day) {
        mem.capNoticeDay = day;
        log(`오늘 해석 한도 ${cfg.llm_daily_cap}회를 다 썼다 — 원문 알림만 보낸다`);
        send({ title: 'ℹ️ sss 감시', text: `오늘 해석 한도(${cfg.llm_daily_cap}회)를 다 써서 이후 공시는 원문 알림만 보낸다. 대화에서 "감시 해석 한도 올려줘"로 바꿀 수 있다.`, silent: true }).catch(() => {});
      }
      mem.queue = [];
      return;
    }
    const candidates = due.slice(0, BATCH_MAX);
    mem.queue = mem.queue.filter((a) => !candidates.includes(a));
    mem.interpreting = (async () => {
      // 원문 확인 — 한국 공시만. 미국 공시는 색인 페이지가 바로 열린다
      const ready = [];
      const waiting = [];
      for (const a of candidates) {
        if (a.source !== 'DART' || !dart?.documentReady) {
          ready.push(a);
          continue;
        }
        let ok = false;
        try {
          ok = await dart.documentReady(a.id.slice('dart:'.length));
        } catch (e) {
          log(`원문 확인 실패 ${a.name}: ${e.message}`);
        }
        if (ok) ready.push(a);
        else if (now() - a.queuedAt < DOC_WAIT_MAX_MS) {
          const checks = (a.checks ?? 0) + 1; // 1·2·4·…·32분 — 안 열리는 원문에 DART 호출을 태우지 않게
          waiting.push({ ...a, checks, nextCheckAt: now() + Math.min(DOC_RECHECK_MS * 2 ** (checks - 1), 32 * 60e3) });
        }
        else {
          log(`원문이 ${DOC_WAIT_MAX_MS / 60e3}분 안에 열리지 않아 해석 건너뜀: ${a.name} — ${a.title} (아침 브리핑이 다룬다)`);
          record({ type: 'interpretation', ok: false, ids: [a.id], error: '원문 미반영 — 해석 건너뜀' });
        }
      }
      mem.queue.push(...waiting);
      if (!ready.length) {
        if (waiting.length) log(`원문이 아직 안 열림 — 해석 보류 ${waiting.length}건 (${waiting.map((a) => a.name).join(', ')})`);
        return;
      }
      const at = now();
      const hhmmss = new Date(at + 9 * 3600e3).toISOString().slice(11, 19).replace(/:/g, '');
      const batch = `${kstDate(new Date(at))}-${hhmmss}`;
      record({ type: 'batch', batch, ids: ready.map((a) => a.id) });
      state.llm.used++;
      save(true);
      log(`해석 시작 ${batch}: ${ready.map((a) => a.name).join(', ')} (오늘 ${state.llm.used}/${cfg.llm_daily_cap})`);
      let r;
      try {
        r = await interpret({ batch, items: ready });
      } catch (e) {
        r = { code: 2, text: null, error: e.message };
      }
      const text = scrubLinks(String(r.text ?? '').trim());
      const ok = r.code === 0 && !!text;
      record({ type: 'interpretation', batch, ok, model: r.model ?? null, ...(ok ? { text } : { error: r.error ?? `exit ${r.code}` }) });
      if (!ok) {
        log(`해석 실패 ${batch}: ${r.error ?? `exit ${r.code}`}`);
        return;
      }
      const names = [...new Set(ready.map((a) => a.name))];
      await send({ title: `🧠 해석 — ${names[0]}${names.length > 1 ? ` 외 ${names.length - 1}` : ''}`, text: `${text}\n\n— 모델 해석(${r.model ?? '?'}). 판단 전에 원문을 확인한다`, silent: true });
      log(`해석 완료 ${batch}`);
    })()
      // 아무도 기다리지 않는 약속이다 — 기록 실패 같은 예외가 새면 처리되지 않은 거부로 감시 전체가 죽는다
      .catch((e) => log(`해석 처리 중 오류: ${e.message}`))
      .finally(() => {
        mem.interpreting = null;
      });
  }

  // ── 공백 ──
  /**
   * 이벤트 루프 박동(BEAT_MS 타이머). 타이머가 GAP_MS 넘게 늦게 왔으면 그동안 프로세스가 멈춰 있었다(맥 잠자기) —
   * 느린 네트워크는 타이머를 늦추지 않는다. 단조 시계로는 못 가린다: macOS 의 Node 는 mach_continuous_time 이라 잠자는 동안에도 간다 (코드 리뷰 실측)
   */
  function beat() {
    const t = now();
    if (mem.lastBeat != null && t - mem.lastBeat > GAP_MS && !mem.pendingGap) mem.pendingGap = { from: mem.lastBeat, to: t };
    mem.lastBeat = t;
  }

  /**
   * 공백 처리. 프로세스를 새로 띄웠으면 직전 감시의 마지막 소식(lastSeen)과 비교하고, 떠 있는 동안은 박동이 잡은 공백을 쓴다.
   * 사용자가 끈 동안(stopped_at · 끄기 표시)은 공백이 아니다
   */
  async function detectGap(t) {
    let gap = null;
    if (!mem.started) {
      mem.started = true;
      mem.lastBeat ??= t;
      if (consumeStopMarker()) state.stopped_at ??= kstStamp(new Date(t)); // 끄는 중에 강제 종료돼 표시만 남은 경우
      if (state.stopped_at) {
        delete state.stopped_at;
        mem.nextAt.dart_sweep = 0; // 켤 때 어제·오늘을 종목별로 따라잡는다
        mem.nextAt.edgar_sweep = 0;
      } else if (startupGap && lastSeen && t - lastSeen > GAP_MS) gap = { from: lastSeen, to: t };
    } else if (mem.pendingGap) {
      gap = mem.pendingGap;
      mem.pendingGap = null;
    }
    if (!gap) return;
    const minutes = Math.round((gap.to - gap.from) / 60e3);
    const g = { from: kstStamp(new Date(gap.from)), to: kstStamp(new Date(gap.to)), minutes };
    state.gaps.push(g);
    record({ type: 'gap', ...g });
    log(`감시 공백 ${minutes}분 (${g.from} ~ ${g.to}) — 종목별 점검으로 따라잡는다`);
    mem.nextAt.dart_sweep = 0;
    mem.nextAt.edgar_sweep = 0;
    if (minutes >= GAP_NOTIFY_MIN) {
      await send({ title: '⚠️ sss 감시 공백', text: `${g.from.slice(5, 16)} ~ ${g.to.slice(11, 16)} (${minutes}분) 감시가 멈춰 있었다 — 맥 잠자기·종료. 그 사이 공시를 지금 따라잡는다.`, silent: true });
    }
  }

  const stopFile = () => join(watchDir(varDir), STOP);
  /** 끄기 표시가 있으면 지우고 true */
  function consumeStopMarker() {
    if (dryRun || !existsSync(stopFile())) return false;
    rmSync(stopFile(), { force: true });
    return true;
  }

  /**
   * 종료 신호를 받은 순간 (동기) — 사용자가 끈 것이면 바로 표시를 저장한다. 도는 중인 한 바퀴가 길면(DART 요청이 느리면)
   * launchd 가 20초 뒤 강제 종료해 루프 끝의 처리까지 못 간다 (코드 리뷰)
   */
  function onSignal() {
    if (consumeStopMarker()) {
      state.stopped_at = kstStamp(new Date(now()));
      save(true);
    }
  }

  // ── 한 틱 ──
  async function tick() {
    const t = now();
    await detectGap(t);
    state.last_tick = t;
    const day = kstDate(new Date(t));
    if (!dryRun && mem.pruneDay !== day) {
      mem.pruneDay = day; // 몇 달 떠 있어도 오래된 기록을 치운다
      pruneRecords(varDir, day);
    }
    const cfg = watchSettings(readSettings(settingsFile));
    keepAwake?.(cfg.keep_awake);
    const targets = loadTargets(t);
    const kr = targets.some((x) => x.market === 'KR');
    const us = targets.some((x) => x.market === 'US');
    const jobs = [
      ['dart', kr && !!env.DART_API_KEY, () => pollDart(t)],
      ['dart_sweep', kr && !!env.DART_API_KEY && !!dart, () => sweepDart(t)],
      ['edgar', us, () => pollEdgar()],
      ['edgar_sweep', us && !!edgar, () => sweepEdgar(t)],
      ['news', targets.length > 0 && cfg.news !== 'off', () => pollNews(cfg.news)],
    ];
    for (const [name, on, run] of jobs) {
      if (mem.lockLost) return;
      if (!on || (mem.nextAt[name] ?? 0) > t) continue;
      mem.nextAt[name] = t + cadence(name, t);
      try {
        await run();
        mem.failures[name] = 0;
      } catch (e) {
        srcFail(name, e);
        // 깨어난 직후처럼 네트워크가 아직 없을 수 있다 — 따라잡기가 한 주기(최대 1시간) 밀리지 않게 1분 뒤부터 2배씩 늘려 다시
        const n = (mem.failures[name] = (mem.failures[name] ?? 0) + 1);
        mem.nextAt[name] = Math.min(mem.nextAt[name], now() + 60e3 * 2 ** (n - 1));
      }
    }
    await flushOutbox();
    maybeInterpret(cfg);
    save();
  }

  /** launchd 가 띄우는 상주 루프. 끝날 때 사용자가 끈 것이면(requestStop) 표시를 남긴다 — 종료·로그아웃은 공백으로 남는다 */
  async function run({ signal } = {}) {
    state.pid = process.pid;
    state.started_at = kstStamp(new Date(now()));
    save(true);
    log(`감시 시작 (pid ${process.pid})`);
    // 틱이 느려도(네트워크 지연) 살아 있다는 표시·잠금은 따로 갱신하고, 잠자기는 박동이 잡는다
    mem.lastBeat = now();
    const pulse = setInterval(() => {
      beat();
      save();
    }, BEAT_MS);
    try {
      while (!signal?.aborted && !mem.lockLost) {
        await tick();
        await new Promise((ok) => {
          const timer = setTimeout(ok, TICK_MS);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            ok();
          }, { once: true });
        });
      }
    } finally {
      clearInterval(pulse);
    }
    if (mem.lockLost) return;
    // 진행 중인 해석을 기다리다 강제 종료될 수 있으니 멈춘 표시를 먼저 남긴다 (신호 때 이미 남겼으면 그대로)
    if (consumeStopMarker()) state.stopped_at = kstStamp(new Date(now()));
    save(true);
    await mem.interpreting;
    save(true);
    log(state.stopped_at ? '감시 종료 (사용자가 끔)' : '감시 종료');
  }

  return {
    tick, run, state, mem, beat, onSignal,
    idle: () => mem.interpreting ?? Promise.resolve(),
    interpretNow: () => maybeInterpret(watchSettings(readSettings(settingsFile)), { force: true }),
  };
}

// 텔레그램은 평문에서도 주소·도메인·@이름을 눌리는 링크로 만든다
const LINK = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s)>\]]*)?/gi;
const TRUSTED_LINK = /^https?:\/\/([a-z0-9-]+\.)*(dart\.fss\.or\.kr|sec\.gov)(\/|$)/i;
/**
 * 모델 답은 그대로 사용자의 폰으로 간다 — 공시 본문에 심긴 피싱 링크가 따라가지 않게 원문 출처(https) 링크만 남기고,
 * 스킴 없는 도메인(evil.com/login · t.me/x)도 지우고, @이름은 눌리지 않게 바꾼다
 */
export const scrubLinks = (text) => text.replace(LINK, (u) => (TRUSTED_LINK.test(u) ? u : '[링크 제거]')).replace(/@(?=\w)/g, '＠');
