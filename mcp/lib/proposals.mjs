/**
 * 제안 대기열 — 자동 실행(브리핑)이 남기고 대화에서 처리하는 위키 반영 제안 (SCENARIOS 공백 #9)
 *
 *  - 승인 카드 UI 가 없어진 자리를 파일로 채운다: wiki/proposals/<id>.md 하나에 제안 하나
 *    (프론트매터 = 상태 추적, 본문 = 이유와 초안). Obsidian 에서도 그대로 열린다
 *  - 같은 원자료(key)는 한 번만 제안한다 — 거절한 공시가 매일 다시 올라오면 확인 피로로 도구를 접게 된다
 *  - 상태는 pending → accepted | rejected 한 번만. 처리는 대화에서만 한다 (자동 실행이면 서버가 거부)
 *  - 받아들여도 이 모듈이 위키 페이지를 쓰지는 않는다. 페이지는 에이전트가 사용자 확인 후 쓰고, 여기엔 처리 결과만 남긴다
 */
import { z } from 'zod';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, parseDocument, stringify } from 'yaml';
import { kstDate, readRegular, wikiDir, writeAtomic } from './store.mjs';

export const DIR = 'proposals';
export const KINDS = ['new-page', 'update-page', 'decision-check', 'other'];
export const STATUSES = ['pending', 'accepted', 'rejected'];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
// 초안 안에 ``` 가 있어도 닫히지 않게 네 개로 감싼다
const DRAFT = /\n## 초안\n\n````markdown\n([\s\S]*?)\n````\n?/;
const nodeId = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, '위키 노드 id (소문자·숫자·하이픈)');

export const addShape = {
  key: z.string().min(3).max(200).describe('원자료 식별자 — briefing_inbox 항목의 id 그대로(예: dart:20260918000123). 같은 key 는 두 번 제안되지 않는다'),
  kind: z.enum(KINDS).describe('new-page 새 페이지 · update-page 기존 페이지 수정 · decision-check 열린 판단의 무효화 조건 점검 · other'),
  title: z.string().min(4).max(120),
  reason: z.string().min(10).max(1000).describe('왜 위키에 남길 가치가 있는가 — 보유·관심 종목, 열린 판단과의 관계'),
  target: nodeId.optional().describe('만들거나 고칠 페이지 id, decision-check 면 판단 id'),
  related: z.array(z.string().max(80)).max(10).default([]).describe('관련 페이지 id 또는 종목코드'),
  sources: z.array(z.string().min(3)).min(1).describe('원문 URL — 출처 없는 제안은 받지 않는다'),
  draft: z.string().max(20000).optional().describe('new-page·update-page 면 페이지 초안(프론트매터 포함 마크다운)'),
};

export const listShape = {
  status: z.enum([...STATUSES, 'all']).default('pending'),
  limit: z.number().int().min(1).max(100).default(20),
};

export const resolveShape = {
  id: z.string().regex(/^p-\d{8}-\d{3}$/),
  status: z.enum(['accepted', 'rejected']),
  note: z.string().max(500).optional().describe('수정해서 받아들였으면 무엇을 바꿨는지, 거절이면 이유 — 다음 제안의 기준이 된다'),
  user_confirmed: z.literal(true, { message: '사용자가 대화에서 승인·거절을 말한 뒤에만 true 로 호출한다' }),
};

function readOne(dir, file) {
  const raw = readRegular(join(dir, file));
  const m = raw?.match(FRONTMATTER);
  if (!m) return null;
  const fm = parse(m[1]) ?? {};
  return { ...fm, draft: m[2].match(DRAFT)?.[1] ?? null, file };
}

function all(root) {
  const dir = wikiDir(root, DIR);
  const out = [];
  for (const f of readdirSync(dir).filter((x) => /^p-\d{8}-\d{3}\.md$/.test(x)).sort()) {
    try {
      const p = readOne(dir, f);
      if (p) out.push(p);
    } catch {
      // 링크·깨진 파일은 대기열에서 뺀다 — 하나 때문에 목록 전체가 죽지 않게
    }
  }
  return { dir, list: out };
}

export function addProposal(root, input, { now = new Date() } = {}) {
  const a = z.object(addShape).parse(input);
  const { dir, list } = all(root);
  const dup = list.find((p) => p.key === a.key);
  if (dup) return { id: dup.id, duplicate: true, status: dup.status };

  const day = kstDate(now);
  const prefix = `p-${day.replace(/-/g, '')}-`;
  let n = list.filter((p) => p.id?.startsWith(prefix)).length + 1;
  const fm = {
    key: a.key,
    kind: a.kind,
    title: a.title,
    ...(a.target && { target: a.target }),
    related: a.related,
    sources: a.sources,
    status: 'pending',
    created: day,
    created_at: now.toISOString(),
  };
  const body = `${a.reason.trim()}\n${a.draft ? `\n## 초안\n\n\`\`\`\`markdown\n${a.draft.trim()}\n\`\`\`\`\n` : ''}`;
  // 동시에 두 실행이 같은 번호를 잡으면 wx 가 실패한다 — 다음 번호로
  for (let tries = 0; tries < 50; tries++, n++) {
    const id = `${prefix}${String(n).padStart(3, '0')}`;
    try {
      writeFileSync(join(dir, `${id}.md`), `---\n${stringify({ id, ...fm }).trimEnd()}\n---\n\n${body}`, { flag: 'wx' });
      return { id, duplicate: false, status: 'pending' };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('제안 id 를 잡지 못했다');
}

export function listProposals(root, input = {}) {
  const { status, limit } = z.object(listShape).parse(input);
  const today = Date.parse(`${kstDate()}T00:00:00Z`);
  const rows = all(root).list
    .filter((p) => status === 'all' || p.status === status)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map(({ file, ...p }) => ({ ...p, age_days: p.created ? Math.round((today - Date.parse(`${p.created}T00:00:00Z`)) / 86400e3) : null }));
  return { status, total: rows.length, proposals: rows.slice(0, limit) };
}

export function resolveProposal(root, input) {
  const r = z.object(resolveShape).parse(input);
  const dir = wikiDir(root, DIR);
  const path = join(dir, `${r.id}.md`);
  const raw = readRegular(path);
  if (raw == null) throw new Error(`없는 제안: ${r.id}`);
  const m = raw.match(FRONTMATTER);
  if (!m) throw new Error(`프론트매터 없음: ${r.id}`);
  const doc = parseDocument(m[1]);
  if (doc.get('status') !== 'pending') throw new Error(`이미 처리된 제안: ${r.id} (${doc.get('status')})`);
  doc.set('status', r.status);
  doc.set('resolved', kstDate());
  if (r.note) doc.set('resolution', r.note);
  writeAtomic(path, `---\n${doc.toString().trimEnd()}\n---\n${m[2].startsWith('\n') ? '' : '\n'}${m[2]}`);
  return { id: r.id, status: r.status };
}
