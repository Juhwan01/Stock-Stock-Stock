import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { addProposal, listProposals, resolveProposal } from '../lib/proposals.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'sss-prop-'));
const proposal = (over = {}) => ({
  key: 'dart:20260918000123',
  kind: 'new-page',
  title: 'SK하이닉스 풍문 답변 — 일본 팹 검토',
  reason: '보유 비중 1위 종목의 설비 투자 방향을 확인한 공시라 위키에 남길 가치가 있다',
  target: 'event-sk-hynix-japan-fab-response-2026-09-18',
  related: ['company-sk-hynix'],
  sources: ['https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260918000123'],
  draft: '---\nid: event-x\ntype: Event\n---\n\n본문 ```코드``` 포함',
  ...over,
});

test('제안은 파일 하나로 남고, 초안은 코드 블록이 섞여도 그대로 돌아온다', () => {
  const r = root();
  const now = new Date('2026-09-27T23:30:00Z'); // 한국 9월 28일 아침
  const a = addProposal(r, proposal(), { now });
  assert.deepEqual(a, { id: 'p-20260928-001', duplicate: false, status: 'pending' });
  assert.ok(readFileSync(join(r, 'proposals', 'p-20260928-001.md'), 'utf8').startsWith('---\nid: p-20260928-001'));
  const [p] = listProposals(r).proposals;
  assert.equal(p.key, 'dart:20260918000123');
  assert.equal(p.draft, proposal().draft);
  assert.equal(addProposal(r, proposal({ key: 'dart:2' }), { now }).id, 'p-20260928-002', '같은 날 번호가 이어진다');
});

test('같은 원자료(key)는 두 번 제안하지 않는다 — 거절한 뒤에도', () => {
  const r = root();
  const { id } = addProposal(r, proposal());
  resolveProposal(r, { id, status: 'rejected', note: '이미 아는 내용', user_confirmed: true });
  assert.deepEqual(addProposal(r, proposal()), { id, duplicate: true, status: 'rejected' });
  assert.equal(readdirSync(join(r, 'proposals')).length, 1);
});

test('출처 없는 제안은 받지 않는다', () => {
  assert.throws(() => addProposal(root(), proposal({ sources: [] })), ZodError);
});

test('처리는 한 번만, 사용자 확인이 있어야 한다. 대기 목록에서 빠지고 이유가 남는다', () => {
  const r = root();
  const { id } = addProposal(r, proposal());
  assert.throws(() => resolveProposal(r, { id, status: 'accepted' }), ZodError);
  resolveProposal(r, { id, status: 'accepted', note: '제목만 고쳐서 반영', user_confirmed: true });
  assert.throws(() => resolveProposal(r, { id, status: 'rejected', user_confirmed: true }), /이미 처리된/);
  assert.equal(listProposals(r).total, 0);
  const [p] = listProposals(r, { status: 'accepted' }).proposals;
  assert.equal(p.resolution, '제목만 고쳐서 반영');
  assert.match(readFileSync(join(r, 'proposals', `${id}.md`), 'utf8'), /본문 ```코드``` 포함/, '처리해도 초안은 보존된다');
});

test('proposals/ 를 위키 밖 링크로 바꾸면 쓰지 않는다', () => {
  const r = root();
  const outside = mkdtempSync(join(tmpdir(), 'sss-outside-'));
  symlinkSync(outside, join(r, 'proposals'));
  assert.throws(() => addProposal(r, proposal()), /실제 디렉터리가 아님/);
  assert.deepEqual(readdirSync(outside), []);
});

test('제안 파일 자리에 링크를 심으면 목록에서 빠지고 처리도 거부한다', () => {
  const r = root();
  mkdirSync(join(r, 'proposals'));
  const outside = mkdtempSync(join(tmpdir(), 'sss-outside-'));
  const victim = join(outside, 'x.md');
  const { id } = addProposal(root(), proposal()); // 다른 위키에서 만든 정상 파일을 피해자로
  symlinkSync(victim, join(r, 'proposals', `${id}.md`));
  assert.equal(listProposals(r, { status: 'all' }).total, 0);
  assert.throws(() => resolveProposal(r, { id, status: 'accepted', user_confirmed: true }), /링크 금지|없는 제안/);
});
