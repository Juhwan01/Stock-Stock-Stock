import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { createWiki, traverse } from '../lib/wiki.mjs';
import { recordDecision, updateDecision, openDecisions, today } from '../lib/decision.mjs';
import { tempWiki } from './helpers.mjs';

const valid = (over = {}) => ({
  slug: 'hynix-hold',
  date: '2026-09-27',
  title: 'SK하이닉스 관망 (루빈 지연 루머)',
  about: ['company-sk-hynix'],
  triggered_by: ['event-rubin-delay-rumor-2026'],
  action: '관망',
  thesis: '2024 블랙웰 때처럼 부품사는 선주문 수혜를 받을 수 있어 지연 루머만으로 줄이지 않는다.',
  confidence: 5,
  expected_outcome: '다음 실적까지 HBM 매출 유지',
  invalidation_condition: '다음 분기 HBM 매출이 전분기 대비 감소하면 무효',
  time_horizon: '다음 실적 발표까지',
  tags: ['반도체', 'HBM', '신제품지연'],
  user_confirmed: true,
  ...over,
});

test('판단을 기록하면 about·triggered-by 엣지를 가진 Decision 노드가 된다', () => {
  const wiki = createWiki(join(tempWiki(), 'pages'));
  const r = recordDecision(wiki, valid());
  assert.equal(r.id, 'decision-hynix-hold-2026-09-27');
  assert.ok(existsSync(r.path));

  const { db } = wiki.get();
  const node = db.prepare(`SELECT type FROM nodes WHERE id = ?`).get(r.id);
  assert.equal(node.type, 'Decision');
  const rels = db.prepare(`SELECT rel, dst FROM edges WHERE src = ? AND rel != 'mentions'`).all(r.id).map((e) => `${e.rel}:${e.dst}`);
  assert.deepEqual(rels.sort(), ['about:company-sk-hynix', 'triggered-by:event-rubin-delay-rumor-2026']);
  assert.ok(openDecisions(db).some((d) => d.id === r.id));
  // about 은 affects 가 아니므로 "무엇이 영향을 주는가" 탐색에 섞이지 않는다
  assert.ok(!traverse(db, 'company-sk-hynix', { hops: 1, rels: ['affects'] }).some((x) => x.id === r.id));
});

test('사용자 확인이 없으면 스키마 단계에서 거부한다', () => {
  const wiki = createWiki(join(tempWiki(), 'pages'));
  assert.throws(() => recordDecision(wiki, valid({ user_confirmed: undefined })), ZodError);
  assert.throws(() => recordDecision(wiki, valid({ user_confirmed: false })), ZodError);
});

test('무효화 조건이 없거나 확신도가 범위를 벗어나면 거부한다', () => {
  const wiki = createWiki(join(tempWiki(), 'pages'));
  assert.throws(() => recordDecision(wiki, valid({ invalidation_condition: undefined })), ZodError);
  assert.throws(() => recordDecision(wiki, valid({ confidence: 11 })), ZodError);
});

test('위키에 없는 노드를 참조하면 거부한다 — 엔티티를 먼저 만들게 한다', () => {
  const wiki = createWiki(join(tempWiki(), 'pages'));
  assert.throws(() => recordDecision(wiki, valid({ about: ['company-samsung'] })), /위키에 없는 노드: company-samsung/);
});

test('같은 날 같은 slug 는 덮어쓰지 않는다', () => {
  const wiki = createWiki(join(tempWiki(), 'pages'));
  recordDecision(wiki, valid());
  assert.throws(() => recordDecision(wiki, valid()), /이미 있는 판단/);
});

test('결과를 기록하면 닫히고, resulted-in 엣지와 회고가 붙고, 다시 닫을 수 없다', () => {
  const wiki = createWiki(join(tempWiki(), 'pages'));
  const { id, path } = recordDecision(wiki, valid({ note: '원래 본문 [[theme-hbm]]' }));
  updateDecision(wiki, {
    id,
    actual_outcome: 'HBM 매출 증가, 주가 상승',
    variance: '기대대로',
    lesson: '지연 루머보다 선주문 동향을 먼저 본 것이 유효했다',
    verdict: '맞음',
    resulted_in: ['event-hbm-demand-strong-2024'],
    note: '관망이 맞았다.',
    user_confirmed: true,
  });
  const text = readFileSync(path, 'utf8');
  assert.match(text, /status: closed/);
  assert.match(text, /verdict: 맞음/);
  assert.match(text, /원래 본문 \[\[theme-hbm\]\]/);
  assert.match(text, /\*\*결과 \(\d{4}-\d{2}-\d{2}\): 맞음\.\*\* 관망이 맞았다\./);

  const { db } = wiki.get();
  assert.ok(db.prepare(`SELECT 1 FROM edges WHERE src = ? AND rel = 'resulted-in' AND dst = 'event-hbm-demand-strong-2024'`).get(id));
  assert.ok(!openDecisions(db).some((d) => d.id === id));
  assert.throws(
    () => updateDecision(wiki, { id, actual_outcome: '다시 닫기 시도', variance: '없음', lesson: '열 글자 이상의 교훈입니다', verdict: '틀림', user_confirmed: true }),
    /이미 결과가 기록된/,
  );
});

test('결과 기록은 프론트매터의 주석을 보존한다', () => {
  const dir = join(tempWiki(), 'pages');
  writeFileSync(
    join(dir, 'decision-commented-2026-01-01.md'),
    [
      '---', 'id: decision-commented-2026-01-01', 'type: Decision', 'title: 주석 있는 판단', 'date: 2026-01-01',
      'decision:', '  action: 매수', '  # 이 주석은 살아남아야 한다', '  thesis: 테스트 논지입니다', 'edges:',
      '  - rel: about', '    to: company-nvidia', '---', '', '본문', '',
    ].join('\n'),
  );
  const wiki = createWiki(dir);
  updateDecision(wiki, {
    id: 'decision-commented-2026-01-01', actual_outcome: '주가 상승함', variance: '없음', lesson: '프로세스가 적절했다고 본다',
    verdict: '맞음', user_confirmed: true,
  });
  const text = readFileSync(join(dir, 'decision-commented-2026-01-01.md'), 'utf8');
  assert.match(text, /# 이 주석은 살아남아야 한다/);
  assert.match(text, /lesson: 프로세스가 적절했다고 본다/);
  assert.match(text, /\n본문\n/);
});

// ── 코드 리뷰 재현 케이스 ───────────────────────────────────────
test('pages/ 를 위키 밖 디렉터리 링크로 바꿔도 서버는 거기에 쓰지 않는다', () => {
  const root = tempWiki();
  const outside = mkdtempSync(join(tmpdir(), 'sss-outside-'));
  cpSync(join(root, 'pages'), outside, { recursive: true }); // 참조 검사를 통과할 가짜 노드까지 준비된 최악의 경우
  rmSync(join(root, 'pages'), { recursive: true });
  symlinkSync(outside, join(root, 'pages'));
  const wiki = createWiki(join(root, 'pages'), { root });
  assert.throws(() => recordDecision(wiki, valid()), /실제 디렉터리가 아님/);
  assert.ok(!readdirSync(outside).some((f) => f.startsWith('decision-hynix-hold')));
});

test('판단 파일 자리에 위키 밖 파일 링크를 심어도 결과 기록이 그 파일을 고치지 않는다', () => {
  const root = tempWiki();
  const victim = join(mkdtempSync(join(tmpdir(), 'sss-victim-')), 'victim.md');
  writeFileSync(victim, '---\nid: decision-victim-2026-01-01\ntype: Decision\ntitle: 피해자\ndate: 2026-01-01\ndecision:\n  thesis: 원본\n---\n원본\n');
  const before = readFileSync(victim, 'utf8');
  symlinkSync(victim, join(root, 'pages', 'decision-victim-2026-01-01.md'));
  const wiki = createWiki(join(root, 'pages'), { root });
  assert.throws(
    () => updateDecision(wiki, { id: 'decision-victim-2026-01-01', actual_outcome: '주입 시도', variance: '없음', lesson: '열 글자 이상의 주입 문장', verdict: '맞음', user_confirmed: true }),
    /일반 파일이 아님/,
  );
  assert.equal(readFileSync(victim, 'utf8'), before);
});

test('status 없이 결과가 적힌 판단(손으로 쓴 형식)도 닫힌 것으로 본다 — 교훈을 덮어쓰지 않는다', () => {
  const wiki = createWiki(join(tempWiki(), 'pages'));
  assert.throws(
    () => updateDecision(wiki, { id: 'decision-hynix-reduce-2024', actual_outcome: '덮어쓰기 시도', variance: '없음', lesson: '원래 교훈을 지우려는 시도', verdict: '맞음', user_confirmed: true }),
    /이미 결과가 기록된/,
  );
  assert.ok(!openDecisions(wiki.get().db).some((d) => d.id === 'decision-hynix-reduce-2024'));
});

test('판단일 기본값은 한국 날짜다 — UTC 로 계산하면 오전 9시 전 판단이 전날로 찍힌다', () => {
  const wiki = createWiki(join(tempWiki(), 'pages'));
  const kst = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(new Date());
  assert.equal(today(), kst);
  const { id } = recordDecision(wiki, valid({ date: undefined }));
  assert.equal(id, `decision-hynix-hold-${kst}`);
});
