/**
 * 위키 루트 안의 파일 쓰기 경계 — 포트폴리오·제안·브리핑 상태가 같이 쓴다
 *
 * 서버와 브리핑 실행기는 Codex 샌드박스 밖에서 돈다. 에이전트는 위키 안을 쓸 수 있으므로 디렉터리나 파일을
 * 위키 밖을 가리키는 링크로 바꿔 쓰기 위치를 옮길 수 있다 (decision.mjs 와 같은 위협, 코드 리뷰 재현).
 *  - 디렉터리: 링크가 아닌 실제 디렉터리이고 위키 루트 바로 아래에 있어야 한다
 *  - 파일 쓰기: 임시 파일 → rename. rename 은 링크를 따라가지 않고 링크 자체를 바꾼다
 *  - 파일 읽기: 링크는 읽지 않는다 — 위키 밖 파일을 위키 데이터처럼 돌려주지 않게
 */
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const lexists = (p) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** 위키 루트 바로 아래의 실제 디렉터리 경로. 없으면 만든다 */
export function wikiDir(root, name) {
  const dir = join(root, name);
  if (!lexists(dir)) mkdirSync(dir);
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${name}/ 가 실제 디렉터리가 아님 (링크 금지): ${dir}`);
  if (realpathSync(dir) !== join(realpathSync(root), name)) throw new Error(`${name}/ 가 위키 밖을 가리킴: ${realpathSync(dir)}`);
  return dir;
}

/** 일반 파일이면 내용, 없으면 null. 링크·디렉터리는 거부한다 */
export function readRegular(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return null;
  }
  if (!st.isFile()) throw new Error(`일반 파일이 아님 (링크 금지): ${path}`);
  return readFileSync(path, 'utf8');
}

/** 같은 디렉터리의 임시 파일에 쓰고 rename — 중간에 죽어도 반쯤 쓴 파일이 남지 않는다 */
export function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, { flag: 'wx' });
  renameSync(tmp, path);
}

const KST_DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
const KST_TIME = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' });
/** 한국 날짜 YYYY-MM-DD — UTC 로 계산하면 오전 9시 전이 전날로 찍힌다 */
export const kstDate = (d = new Date()) => KST_DAY.format(d);
/** 한국 시각 YYYY-MM-DD HH:MM:SS */
export const kstStamp = (d = new Date()) => `${KST_TIME.format(d)} KST`;
const KST_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' });
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/** 한국 시각의 요일(0=일)·시·분 */
export function kstParts(d = new Date()) {
  const p = Object.fromEntries(KST_PARTS.formatToParts(d).map((x) => [x.type, x.value]));
  return { weekday: WEEKDAY[p.weekday], hour: Number(p.hour), minute: Number(p.minute) };
}
/** 한국 시각 HH:MM */
export const kstTime = (d = new Date()) => {
  const { hour, minute } = kstParts(d);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};
/** YYYY-MM-DD 에 n일을 더한다 */
export const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
