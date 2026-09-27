.mode list
.headers off

-- 실제 위키 페이지에 들어갈 법한 한국어 문장으로 테스트
CREATE VIRTUAL TABLE t_uni USING fts5(title, body, tokenize='unicode61');
CREATE VIRTUAL TABLE t_tri USING fts5(title, body, tokenize='trigram');

INSERT INTO t_uni VALUES
  ('삼성전자 HBM 공급 계약', '삼성전자가 엔비디아에 HBM3E를 공급하기로 했다. 반도체 업황 회복 신호로 해석된다.'),
  ('한국은행 기준금리 동결', '한국은행이 기준금리를 3.50%로 동결했다. 시장은 인하 시점을 2026년 하반기로 본다.'),
  ('SK하이닉스 실적 발표', 'SK하이닉스의 영업이익이 시장 컨센서스를 상회했다. 메모리 가격 상승이 주효했다.');

INSERT INTO t_tri SELECT * FROM t_uni;

SELECT '--- [1] unicode61: 어절 전체 일치 "삼성전자" ---';
SELECT title FROM t_uni WHERE t_uni MATCH '삼성전자';

SELECT '--- [2] unicode61: 조사 붙은 형태 검색 "삼성전자가" 는 매칭되나 ---';
SELECT title FROM t_uni WHERE t_uni MATCH '삼성전자가';

SELECT '--- [3] unicode61: 부분어 "하이닉스" (SK하이닉스 안에 포함) ---';
SELECT title FROM t_uni WHERE t_uni MATCH '하이닉스';

SELECT '--- [4] unicode61: prefix 쿼리 "기준금리*" ---';
SELECT title FROM t_uni WHERE t_uni MATCH '기준금리*';

SELECT '--- [5] trigram: 부분어 "하이닉스" ---';
SELECT title FROM t_tri WHERE t_tri MATCH '하이닉스';

SELECT '--- [6] trigram: 조사 무시 "삼성전자" (원문은 삼성전자가) ---';
SELECT title FROM t_tri WHERE t_tri MATCH '삼성전자';

SELECT '--- [7] trigram: 2글자 쿼리 "금리" (3글자 미만) ---';
SELECT title FROM t_tri WHERE t_tri MATCH '금리';

SELECT '--- [8] trigram: 3글자 쿼리 "기준금" ---';
SELECT title FROM t_tri WHERE t_tri MATCH '기준금';

SELECT '--- [9] trigram: 영문+숫자 혼합 "HBM3E" ---';
SELECT title FROM t_tri WHERE t_tri MATCH 'HBM3E';

SELECT '--- [10] trigram: 영문 소문자 쿼리 "hbm" (대소문자 무시 확인) ---';
SELECT title FROM t_tri WHERE t_tri MATCH 'hbm';

SELECT '--- [11] trigram: 구문 "메모리 가격" ---';
SELECT title FROM t_tri WHERE t_tri MATCH '"메모리 가격"';

SELECT '--- [12] trigram: bm25 랭킹 동작 확인 ---';
SELECT title, round(bm25(t_tri), 3) FROM t_tri WHERE t_tri MATCH '반도체' ORDER BY bm25(t_tri);
