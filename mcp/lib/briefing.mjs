/**
 * 아침 브리핑의 결정론적 부분 (PLAN.md M2) — 수집 · 중복 제거 · 상태 · 대체 브리핑. LLM 은 분류와 해석만 한다
 *
 *  - 수집은 코드가 한다: 보유·관심 종목 전부를 빠짐없이, 구독 한도를 쓰지 않고. 모델에게 맡기면 종목을 건너뛴다
 *  - 원자료는 wiki/briefings/.inbox-<날짜>.json 에 두고 에이전트는 briefing_inbox 도구로 읽는다 —
 *    공시 제목 같은 외부 텍스트를 지시(프롬프트)가 아니라 도구 결과(데이터)로 넘긴다 (비신뢰 입력, §8 공백 6)
 *  - 한 번 브리핑에 실린 항목은 다시 싣지 않는다(state.seen). API 가 날짜 단위라 범위는 겹쳐 잡고 id 로 거른다
 *  - LLM 실행이 실패해도 원자료만으로 된 브리핑을 남긴다 — 아침에 빈손이 되지 않게
 *  - 시세는 싣지 않는다: 공식 일별 시세는 T+1 13시라 아침엔 이틀 전 값이고, 비공식 시세는 위키(이 폴더)에 남기지 않는다
 */
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDecisions } from './decision.mjs';
import { addDays, kstDate, lexists, readRegular, wikiDir, writeAtomic } from './store.mjs';

export const BRIEFINGS = 'briefings';
const STATE = '.state.json';
// 원자료는 브리핑 파일과 같은 이름: <날짜> 또는 같은 날 다시 돈 <날짜>-2 …
const INBOX = /^\.inbox-(\d{4}-\d{2}-\d{2})(?:-(\d+))?\.json$/;
export const RUN_ID = /^\d{4}-\d{2}-\d{2}(-\d+)?$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DART_PAGES = 10; // 종목당 최대 1,000건 — 넘으면 수집 공백으로 보고한다
const EDGAR_RECENT = 200;

// 분류 힌트 — 대형주에 매일 쏟아지는 기계적 공시. 최종 판단은 에이전트가 한다
const ROUTINE_KR = [
  /임원\s*[ㆍ·.]?\s*주요주주\s*특정증권등\s*소유상황보고서/,
  /주식등의\s*대량보유상황보고서/,
  /증권발행실적보고서/,
  /투자설명서/,
  /일괄신고추가서류/,
];
const ROUTINE_US = new Set(['3', '4', '5', '144', 'SC 13G', 'SC 13G/A', '424B2', '424B3', 'FWP', 'S-8']);

const ymd = (d) => d.replace(/-/g, '');

/**
 * 보유·관심 종목의 새 공시를 모은다. 실패는 종목 단위로 격리해 보고한다 — 한 종목 때문에 브리핑 전체가 죽지 않게
 * 잘린 수집은 조용히 넘기지 않고 failures 에 싣는다 — 수집 시작일이 앞으로 가면 잘린 항목은 영영 다시 오지 않는다
 * @param dart   { filings(code, { from, to, limit, page }) → { total, filings } }
 * @param edgar  { recentFilings(ticker, limit) → { filings } (최신순) }
 */
export async function collectUpdates({ universe, since, until, seen = {}, dart, edgar }) {
  const items = [];
  const failures = [];
  let krBlocked = false;
  for (const u of universe) {
    const base = { market: u.market, code: u.code, name: u.name, role: u.role, weight: u.weight };
    const got = [];
    try {
      if (u.market === 'KR') {
        if (krBlocked) continue;
        let total = 0;
        for (let page = 1; page <= DART_PAGES; page++) {
          const r = await dart.filings(u.code, { from: ymd(since), to: ymd(until), limit: 100, page });
          total = r.total ?? r.filings.length;
          for (const f of r.filings) {
            got.push({
              id: `dart:${f.rcept_no}`, ...base, date: f.date, title: f.title, filer: f.filer, url: f.url,
              hint: ROUTINE_KR.some((re) => re.test(f.title)) ? 'routine' : null,
            });
          }
          if (got.length >= total || !r.filings.length) break;
        }
        if (got.length < total) failures.push({ scope: `KR:${u.code} ${u.name}`, error: `공시 ${total}건 중 ${got.length}건만 수집 — 나머지는 --since 를 좁혀 다시 돌린다` });
      } else {
        const r = await edgar.recentFilings(u.code, EDGAR_RECENT);
        const oldest = r.filings.at(-1);
        if (r.filings.length >= EDGAR_RECENT && oldest.filed >= since) {
          failures.push({ scope: `US:${u.code} ${u.name}`, error: `최근 공시 ${EDGAR_RECENT}건이 모두 수집 기간 안 — ${oldest.filed} 이전 것은 빠졌을 수 있다` });
        }
        for (const f of r.filings) {
          if (f.filed < since || f.filed > until) continue;
          got.push({
            id: `sec:${f.accession}`, ...base, date: f.filed, title: `${f.form}${f.items ? ` (items ${f.items})` : ''}`,
            form: f.form, url: f.url, hint: ROUTINE_US.has(f.form) ? 'routine' : null,
          });
        }
      }
    } catch (e) {
      if (e.code === 'NO_KEY') {
        krBlocked = true; // 키가 없으면 한국 종목 전부 같은 이유로 실패한다 — 한 번만 보고
        failures.push({ scope: 'KR 전체', error: e.message });
      } else {
        failures.push({ scope: `${u.market}:${u.code} ${u.name}`, error: e.message });
      }
      continue;
    }
    got.sort((a, b) => b.date.localeCompare(a.date));
    items.push(...got.filter((x) => !seen[x.id]));
  }
  return { items, failures };
}

/** 열린 판단과 그 대상 종목에 걸린 새 항목 — 무효화 조건 점검의 입력 */
export function decisionContext(db, items) {
  const about = db.prepare(`SELECT dst FROM edges WHERE src = ? AND rel = 'about'`);
  const tickerOf = db.prepare(`SELECT ticker FROM nodes WHERE id = ?`);
  return openDecisions(db).map((d) => {
    const targets = about.all(d.id).map((r) => r.dst);
    const tickers = new Set(targets.map((id) => tickerOf.get(id)?.ticker?.toUpperCase()).filter(Boolean));
    return {
      id: d.id,
      title: d.title,
      date: d.date,
      action: d.decision.action ?? null,
      invalidation_condition: d.decision.invalidation_condition ?? null,
      time_horizon: d.decision.time_horizon ?? null,
      about: targets,
      related_items: items.filter((i) => tickers.has(i.code.toUpperCase())).map((i) => i.id),
    };
  });
}

// ── 상태: 마지막 실행과 이미 실은 항목 ───────────────────────────
/**
 * 에이전트는 위키 안의 이 파일을 고칠 수 있다 — 날짜 모양이 아니거나 오늘보다 늦은 값은 버린다
 * (수집 시작일이 프롬프트에 들어가고, 미래 날짜가 남으면 긴 공백 뒤의 공시를 조용히 놓친다 — 코드 리뷰 재현).
 * 알려진 한계: 대화형 에이전트가 seen 에 id 를 넣어 공시를 숨기는 것은 막지 못한다 — 대화는 사용자가 보고 있고,
 * 무인 실행(브리핑)은 읽기 전용이라 이 파일을 고치지 못한다
 */
export function readState(root, { today = kstDate() } = {}) {
  const raw = readRegular(join(wikiDir(root, BRIEFINGS), STATE));
  let s = {};
  try {
    s = raw ? JSON.parse(raw) : {};
  } catch {}
  const seen = s.seen && typeof s.seen === 'object' && !Array.isArray(s.seen) ? s.seen : {};
  return {
    last_run: typeof s.last_run === 'string' ? s.last_run : null,
    last_date: typeof s.last_date === 'string' && DAY.test(s.last_date) && s.last_date <= today ? s.last_date : null,
    seen: Object.fromEntries(Object.entries(seen).filter(([, d]) => typeof d === 'string' && DAY.test(d))),
  };
}

export function writeState(root, state, { keepDays = 30, today = kstDate() } = {}) {
  const cutoff = addDays(today, -keepDays);
  const seen = Object.fromEntries(Object.entries(state.seen).filter(([, d]) => d >= cutoff));
  writeAtomic(join(wikiDir(root, BRIEFINGS), STATE), JSON.stringify({ ...state, seen }, null, 1));
}

/**
 * 수집 시작일 — 지정값 > 마지막 브리핑 날짜(그날 저녁 공시까지 잡으려고 겹친다) > 사흘 전(주말 포함).
 * 브리핑 날짜보다 늦을 수 없다 (과거 날짜로 다시 돌리거나 상태가 미래를 가리킬 때)
 */
export function sinceFor(state, today, override) {
  const last = state.last_date && state.last_date <= today ? state.last_date : null;
  const s = override ?? last ?? addDays(today, -3);
  return s > today ? today : s;
}

/** 마지막 브리핑 날짜는 뒤로 가지 않는다 — 과거 날짜로 다시 돌려도 다음 수집 범위가 넓어지지 않게 */
export const nextLastDate = (state, date) => (state.last_date && state.last_date > date ? state.last_date : date);

// ── 원자료 (inbox) ───────────────────────────────────────────────
const runKey = (run) => {
  const m = run.match(/^(\d{4}-\d{2}-\d{2})(?:-(\d+))?$/);
  return [m[1], Number(m[2] ?? 1)];
};

export function writeInbox(root, inbox, { keepDays = 30 } = {}) {
  const dir = wikiDir(root, BRIEFINGS);
  const run = inbox.run ?? inbox.date;
  if (!RUN_ID.test(run)) throw new Error(`브리핑 실행 이름이 아님: ${run}`);
  writeAtomic(join(dir, `.inbox-${run}.json`), JSON.stringify(inbox, null, 1));
  const cutoff = addDays(inbox.date, -keepDays);
  for (const f of readdirSync(dir)) {
    const m = f.match(INBOX);
    if (m && m[1] < cutoff && lstatSync(join(dir, f)).isFile()) rmSync(join(dir, f));
  }
}

/** run: <날짜> 또는 <날짜>-N. 생략하면 가장 최근 실행 */
export function readInbox(root, run) {
  const dir = wikiDir(root, BRIEFINGS);
  const latest = () =>
    readdirSync(dir)
      .map((f) => f.match(INBOX) && f.slice('.inbox-'.length, -'.json'.length))
      .filter(Boolean)
      .sort((a, b) => {
        const [da, na] = runKey(a);
        const [db, nb] = runKey(b);
        return da.localeCompare(db) || na - nb;
      })
      .pop();
  const id = run ?? latest();
  if (!id) throw new Error('브리핑 원자료가 없음 — node bin/sss.mjs briefing 이 먼저 돌아야 한다');
  if (!RUN_ID.test(id)) throw new Error(`브리핑 실행 이름이 아님: ${id}`);
  const raw = readRegular(join(dir, `.inbox-${id}.json`));
  if (raw == null) throw new Error(`${id} 브리핑 원자료가 없음`);
  return JSON.parse(raw);
}

export const briefingPath = (root, date) => join(wikiDir(root, BRIEFINGS), `${date}.md`);

/** 같은 날 두 번째 실행은 아침 브리핑을 덮어쓰지 않고 <날짜>-2.md, -3.md … 로 쓴다 */
export function nextBriefingPath(root, date) {
  const dir = wikiDir(root, BRIEFINGS);
  for (let n = 1; ; n++) {
    const p = join(dir, n === 1 ? `${date}.md` : `${date}-${n}.md`);
    if (!lexists(p)) return p;
  }
}

// ── 대체 브리핑 — 모델 없이 원자료만으로 ─────────────────────────
const line = (i) => `- ${i.name}(${i.code}) · ${i.date} · ${i.title}${i.hint ? ' _(기계적 공시)_' : ''} · [원문](${i.url})`;

export function fallbackMarkdown(inbox, reason) {
  const sections = [];
  const add = (title, lines) => sections.push(`## ${title}\n\n${lines.join('\n')}`);
  const flagged = inbox.open_decisions.filter((d) => d.related_items.length);
  add('먼저 볼 것', [
    ...(flagged.length
      ? flagged.map((d) => `- 열린 판단 [[${d.id}]] 의 대상에 새 항목 ${d.related_items.length}건 — 무효화 조건: ${d.invalidation_condition}`)
      : [`- 열린 판단 ${inbox.open_decisions.length}건 — 대상 종목의 새 항목 없음`]),
    `- 대기 중 제안 ${inbox.pending_proposals.count}건`,
  ]);
  for (const [role, title] of [['holding', '보유 종목'], ['watch', '관심 종목']]) {
    const xs = inbox.items.filter((i) => i.role === role);
    if (xs.length) add(`${title} — 분류 안 됨 (원자료)`, xs.map(line));
  }
  if (!inbox.items.length) add('새 항목', ['- 없음']);
  if (inbox.failures.length) add('수집 공백', inbox.failures.map((f) => `- ${f.scope}: ${f.error}`));
  if (inbox.notes?.length) add('참고', inbox.notes.map((n) => `- ${n}`));

  return [
    '---',
    `date: ${inbox.date}`,
    `generated_at: ${inbox.generated_at}`,
    `since: ${inbox.since}`,
    'fallback: true',
    `counts: { items: ${inbox.items.length}, failures: ${inbox.failures.length} }`,
    '---',
    '',
    `# ${inbox.date} 아침 브리핑 (원자료만)`,
    '',
    `> ${reason}`,
    `> 수집 ${inbox.since} ~ ${inbox.until} · 보유 ${inbox.universe.filter((u) => u.role === 'holding').length} · 관심 ${inbox.universe.filter((u) => u.role === 'watch').length} · 생성 ${inbox.generated_at}`,
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');
}

export const renderPrompt = (template, vars) => template.replace(/\{\{(\w+)\}\}/g, (all, k) => (k in vars ? String(vars[k]) : all));

/**
 * 모델의 최종 답(읽기 전용 실행이라 파일을 쓰지 않는다) → 브리핑 파일 내용.
 *  - 프론트매터가 없으면 붙인다 — 형식이 조금 틀렸다고 분석을 버리지 않는다
 *  - 모델이 빠뜨린 원자료 항목은 "누락" 절에 원자료 그대로 싣는다. 실린 항목은 다음 브리핑에 다시 오지 않으므로
 *    빠뜨린 채 두면 조용히 사라진다 (코드 리뷰 High)
 */
export function finalizeModelBriefing(text, inbox) {
  let md = String(text ?? '').trim().replace(/^```(?:markdown)?\n([\s\S]*?)\n```$/, '$1').trim();
  if (!md) return null;
  if (!/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.test(md)) {
    md = `---\ndate: ${inbox.date}\ngenerated_at: ${inbox.generated_at}\nsince: ${inbox.since}\n---\n\n${md}`;
  }
  const missing = inbox.items.filter((i) => !md.includes(i.url));
  if (missing.length) {
    md += `\n\n## 누락 — 원자료\n\n> 모델이 분류하지 않은 항목 ${missing.length}건을 원자료 그대로 싣는다\n\n${missing.map(line).join('\n')}`;
  }
  return { markdown: `${md}\n`, missing: missing.length };
}

/**
 * 브리핑 내용을 만든다. reason 이 있으면 모델 없이 원자료만. 모델이 실패하거나 빈 답이면 원자료로 대체한다
 * @param runModel  async () => { code, text }
 */
export async function produceBriefing({ inbox, reason, runModel }) {
  if (reason) return { markdown: fallbackMarkdown(inbox, reason), fallback: true, missing: 0 };
  let r;
  try {
    r = await runModel();
  } catch (e) {
    r = { code: 2, text: null, error: e.message };
  }
  const fin = r.code === 0 ? finalizeModelBriefing(r.text, inbox) : null;
  if (!fin) {
    const why = `모델 실행 실패 (exit ${r.code}${r.code === 0 ? ', 빈 답' : ''}${r.error ? `, ${r.error}` : ''}) — 원자료만 남긴다. 로그: var/briefing.log`;
    return { markdown: fallbackMarkdown(inbox, why), fallback: true, missing: 0 };
  }
  return { ...fin, fallback: false };
}
