.mode list
.headers off

CREATE VIRTUAL TABLE docs USING fts5(title, body, tokenize='trigram');

-- 위키 5,000 페이지 규모를 모사 (개인용 앱의 수년치 축적 상한 가정)
WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < 5000)
INSERT INTO docs
SELECT
  '페이지 ' || i || ' 시황 노트',
  CASE i % 5
    WHEN 0 THEN '한국은행이 기준금리를 동결했다. 금리 인하 기대가 후퇴하며 성장주 밸류에이션 부담이 커졌다. 채권 시장은 관망세다.'
    WHEN 1 THEN 'SK하이닉스의 영업이익이 컨센서스를 상회했다. 메모리 가격 상승과 HBM 출하 증가가 실적을 견인했다.'
    WHEN 2 THEN '원달러 환율이 1,380원을 돌파했다. 수출주에는 우호적이나 외국인 수급에는 부담으로 작용한다.'
    WHEN 3 THEN '삼성전자가 엔비디아 HBM3E 퀄테스트를 통과했다. 반도체 업황 회복의 신호로 해석된다.'
    ELSE '국제 유가가 배럴당 82달러로 상승했다. 정유주 마진 개선이 예상되나 항공주에는 비용 압박이다.'
  END || ' (문서 ' || i || ')'
FROM seq;

SELECT '### 코퍼스 규모: ' || count(*) || ' 페이지' FROM docs;

.timer on

SELECT '--- [A] trigram MATCH 3글자 "기준금" (인덱스 사용) ---';
SELECT count(*) FROM docs WHERE docs MATCH '기준금';

SELECT '--- [B] 2글자 MATCH "금리" → 실패 확인 ---';
SELECT count(*) FROM docs WHERE docs MATCH '금리';

SELECT '--- [C] 2글자 LIKE fallback: body LIKE %금리% (trigram 인덱스가 가속하는지) ---';
SELECT count(*) FROM docs WHERE body LIKE '%금리%';

SELECT '--- [D] 2글자 LIKE fallback: %환율% ---';
SELECT count(*) FROM docs WHERE body LIKE '%환율%';

SELECT '--- [E] 2글자 LIKE fallback: %실적% ---';
SELECT count(*) FROM docs WHERE body LIKE '%실적%';

SELECT '--- [F] 1글자 LIKE: %유% (최악 케이스) ---';
SELECT count(*) FROM docs WHERE body LIKE '%유%';

.timer off

SELECT '--- [G] LIKE 쿼리 플랜 (trigram 인덱스 사용 여부) ---';
EXPLAIN QUERY PLAN SELECT * FROM docs WHERE body LIKE '%금리%';

SELECT '--- [H] MATCH 쿼리 플랜 ---';
EXPLAIN QUERY PLAN SELECT * FROM docs WHERE docs MATCH '기준금';
