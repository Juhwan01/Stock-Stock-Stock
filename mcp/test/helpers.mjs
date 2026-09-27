import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_PAGES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pages');

/** 샘플 7페이지(블랙웰 지연 → 비중축소 → 반증 → 루빈 루머)를 담은 임시 위키. 반환값은 wiki 루트 */
export function tempWiki() {
  const dir = mkdtempSync(join(tmpdir(), 'sss-wiki-'));
  cpSync(FIXTURE_PAGES, join(dir, 'pages'), { recursive: true });
  return dir;
}
