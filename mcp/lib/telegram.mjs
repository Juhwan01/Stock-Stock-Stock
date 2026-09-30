/**
 * 텔레그램 푸시 (PLAN.md M3, §7-6 "알림은 텔레그램 푸시가 기본")
 *
 *  - 봇 토큰은 .env 의 TELEGRAM_BOT_TOKEN — 대화로 받지 않는다 (AGENTS.md §5). 오류 메시지에 토큰이 새지 않게 지운다
 *  - 받을 대화(chat_id)는 연결 코드로 묶는다: 도구가 6자리 코드를 만들고, 사용자가 봇에게 그 코드를 보내면 그 대화를 저장한다.
 *    봇 이름은 누구나 찾을 수 있다 — "처음 말 건 사람"을 묶으면 남이 먼저 말을 걸어 알림을 가로챌 수 있다
 *  - 보내는 글은 평문이다(parse_mode 없음) — 외부 공시·뉴스 제목이 서식·링크 문법으로 해석되지 않게
 */
import { randomInt } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readSettings, updateSettings, SETTINGS_FILE } from './settings.mjs';

const API = 'https://api.telegram.org';
export const MAX_TEXT = 4000; // 텔레그램 한도 4096
const LINK_TTL_MS = 10 * 60e3;

export const clip = (text, max = MAX_TEXT) => (text.length > max ? `${text.slice(0, max - 20)}\n…(잘림)` : text);

export function createTelegram({ token, fetch = globalThis.fetch }) {
  if (!token) throw Object.assign(new Error('TELEGRAM_BOT_TOKEN 미설정 — 텔레그램 @BotFather 에서 봇을 만들고 레포의 .env 에 TELEGRAM_BOT_TOKEN=... 로 넣는다'), { code: 'NO_TOKEN' });
  const scrub = (s) => String(s).split(token).join('<token>');
  async function api(method, body = {}) {
    let res;
    let d = null;
    try {
      res = await fetch(`${API}/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15e3) });
      d = await res.json().catch(() => null);
    } catch (e) {
      throw new Error(`텔레그램 ${method} 연결 실패: ${scrub(e.cause?.message ?? e.message)}`);
    }
    if (!d?.ok) {
      const e = new Error(`텔레그램 ${method} 실패: ${scrub(d?.description ?? `HTTP ${res.status}`)}`);
      e.status = res.status;
      e.retryAfter = d?.parameters?.retry_after ?? null;
      throw e;
    }
    return d.result;
  }
  return {
    getMe: () => api('getMe'),
    updates: (offset) => api('getUpdates', { ...(offset != null && { offset }), timeout: 0, allowed_updates: ['message'] }),
    send: (chatId, text, { silent = false } = {}) =>
      api('sendMessage', { chat_id: chatId, text: clip(text), disable_notification: silent, link_preview_options: { is_disabled: true } }),
  };
}

/** 연결 상태 — chat_id 는 비밀은 아니지만 보여줄 필요도 없어 이름만 */
export function telegramStatus({ env = process.env, settings = readSettings() } = {}) {
  const t = settings.telegram ?? {};
  return {
    token_set: !!env.TELEGRAM_BOT_TOKEN,
    linked: !!(env.TELEGRAM_BOT_TOKEN && t.chat_id),
    chat: t.chat_id ? t.chat_name ?? null : null,
    linked_at: t.linked_at ?? null,
    pending_link: t.pending && t.pending.expires > Date.now() ? { expires_at: new Date(t.pending.expires).toISOString() } : null,
  };
}

/** 1단계: 코드를 만들고 봇 이름과 딥링크를 돌려준다. 사용자는 링크를 열어 시작을 누르거나 코드를 봇에게 보낸다 */
export async function startLink({ tg, file = SETTINGS_FILE, now = Date.now() }) {
  const me = await tg.getMe();
  const code = String(randomInt(100000, 1000000));
  updateSettings((s) => ({ ...s, telegram: { ...(s.telegram ?? {}), pending: { code, expires: now + LINK_TTL_MS } } }), file);
  return {
    bot: `@${me.username}`,
    code,
    link: `https://t.me/${me.username}?start=${code}`,
    expires_in_minutes: LINK_TTL_MS / 60e3,
    next: `텔레그램에서 링크를 열고 [시작]을 누르거나, @${me.username} 에게 ${code} 를 보낸 뒤 "보냈어"라고 말한다`,
  };
}

/** 2단계: 봇이 받은 메시지에서 코드를 찾아 그 1:1 대화를 묶는다. 확인 메시지를 보내 실제로 닿는지 본다 */
export async function confirmLink({ tg, file = SETTINGS_FILE, now = Date.now() }) {
  const pending = readSettings(file).telegram?.pending;
  if (!pending?.code) throw new Error('진행 중인 연결이 없다 — 먼저 연결을 시작해 코드를 받는다');
  if (pending.expires < now) throw new Error('연결 코드가 만료됐다 (10분) — 다시 시작해 새 코드를 받는다');
  // 가장 최근 100개 — 오프셋 없이 받으면 가장 오래된 100개라, 남이 봇에 메시지를 쌓아 코드를 묻을 수 있다 (코드 리뷰)
  const updates = await tg.updates(-100);
  const hit = updates
    .map((u) => u.message)
    .filter((m) => m?.chat?.type === 'private' && m.date * 1000 >= pending.expires - LINK_TTL_MS - 60e3)
    .reverse()
    .find((m) => [pending.code, `/start ${pending.code}`].includes(String(m.text ?? '').trim()));
  if (!hit) throw new Error(`봇이 코드 ${pending.code} 를 아직 받지 못했다 — 봇과의 1:1 대화에서 코드를 보냈는지 확인하고 다시 확인을 요청한다`);
  // 읽은 메시지를 치운다 — 다음 연결 때 옛 코드를 다시 보지 않게
  if (updates.length) await tg.updates(updates.at(-1).update_id + 1).catch(() => {});
  const chatName = hit.chat.username ? `@${hit.chat.username}` : [hit.chat.first_name, hit.chat.last_name].filter(Boolean).join(' ') || '(이름 없음)';
  await tg.send(hit.chat.id, '✅ sss 연결됨 — 공시·뉴스 감시 알림과 아침 브리핑 요약이 여기로 온다.');
  updateSettings((s) => ({ ...s, telegram: { chat_id: hit.chat.id, chat_name: chatName, linked_at: new Date(now).toISOString() } }), file);
  return { linked: true, chat: chatName };
}

export function unlink(file = SETTINGS_FILE) {
  const had = !!readSettings(file).telegram?.chat_id;
  updateSettings((s) => {
    const { telegram, ...rest } = s;
    return rest;
  }, file);
  return { linked: false, removed: had };
}

/** macOS 알림 — 텔레그램이 없을 때의 대체 */
export function macNotify(title, message) {
  if (process.platform !== 'darwin' || process.env.SSS_NO_NOTIFY === '1') return false;
  // JSON 문자열 표기는 AppleScript 문자열 이스케이프(\" \\)와 호환된다
  const r = spawnSync('osascript', ['-e', `display notification ${JSON.stringify(message.slice(0, 200))} with title ${JSON.stringify(title)}`], { stdio: 'ignore' });
  return r.status === 0;
}

/**
 * 알림 한 건을 보낸다: 텔레그램이 연결돼 있으면 텔레그램, 아니면 macOS 알림.
 * fallback=false 면 텔레그램 실패 때 macOS 알림을 띄우지 않는다 (재시도마다 같은 알림이 뜨지 않게)
 * @returns { via: 'telegram' | 'mac' | null, error? }
 */
export async function push({ title, text, silent = false, fallback = true }, { env = process.env, file = SETTINGS_FILE, fetch = globalThis.fetch, mac = macNotify } = {}) {
  const chatId = readSettings(file).telegram?.chat_id;
  if (env.TELEGRAM_BOT_TOKEN && chatId) {
    try {
      await createTelegram({ token: env.TELEGRAM_BOT_TOKEN, fetch }).send(chatId, `${title}\n${text}`, { silent });
      return { via: 'telegram' };
    } catch (e) {
      // 텔레그램이 안 되면 맥에라도 — 실패는 호출한 쪽이 기록하고 다시 보낸다
      if (fallback) mac(title, text);
      return { via: null, error: e.message, retryAfter: e.retryAfter ?? null };
    }
  }
  return { via: mac(title, text) ? 'mac' : null };
}
