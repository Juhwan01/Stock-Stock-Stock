/**
 * 운영 설정 파일 (var/settings.json) — 용도별 모델 · 감시 · 텔레그램 연결
 *
 * 레포의 var/ 에 둔다 — 에이전트의 쓰기 범위(wiki/) 밖이라 승인을 거친 도구로만 바뀐다.
 * 테스트는 SSS_VAR_DIR 로 위치를 바꾼다
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SETTINGS_FILE = join(process.env.SSS_VAR_DIR ?? join(REPO, 'var'), 'settings.json');

export function readSettings(file = SETTINGS_FILE) {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  } catch {
    return {};
  }
}

/** 읽고 → fn 으로 바꾸고 → 임시 파일 + rename 으로 쓴다. fn 이 돌려준 새 설정을 돌려준다 */
export function updateSettings(fn, file = SETTINGS_FILE) {
  const next = fn(readSettings(file));
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, file);
  return next;
}
