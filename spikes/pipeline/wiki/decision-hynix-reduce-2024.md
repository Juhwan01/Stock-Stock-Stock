---
id: decision-hynix-reduce-2024
type: Decision
title: SK하이닉스 비중 축소 (블랙웰 지연 대응)
date: 2024-08-07
tags: [반도체, HBM, 신제품지연, 비중축소]
decision:
  action: 비중축소
  thesis: 블랙웰 출시가 지연되면 HBM3E 수요도 함께 이연된다. 4분기 실적 컨센서스가 하향될 것.
  confidence: 6
  expected_outcome: 3개월 내 10~15% 조정
  expected_probability: 0.6
  invalidation_condition: 3분기 실적에서 HBM 매출이 전분기 대비 증가하면 논지가 틀린 것
  time_horizon: 3개월
  emotion: 불안 — 고점 대비 하락 중이라 손실 회피 심리가 있었음
  # --- 결과 업데이트 (2024-11-20) ---
  actual_outcome: 틀림. HBM 매출 증가, 주가는 축소 시점 대비 상승
  variance: 기대와 정반대. 확신도 6은 과대평가였음
  lesson: 최종재 지연을 부품 수요 감소로 직결시킨 것이 오류. 부품사는 공급 부족 우려에 따른 선주문 수혜를 받을 수 있다. 다음에 "신제품 지연" 뉴스를 만나면 반드시 부품사 재고·선주문 동향을 먼저 확인할 것.
edges:
  - rel: triggered-by
    to: event-blackwell-delay-2024
  - rel: resulted-in
    to: event-hbm-demand-strong-2024
    note: 무효화 조건이 실제로 충족되어 논지가 반증됨
  # 'affects'가 아니라 'about' — 결정은 종목에 "영향을 주는" 것이 아니라 "대상으로 하는" 것이다.
  # 이를 구분하지 않으면 "무엇이 이 종목에 영향을 주는가" 질의에 내 결정이 섞여 들어온다.
  - rel: about
    to: company-sk-hynix
---

블랙웰 지연 보도([[event-blackwell-delay-2024]]) 직후 SK하이닉스 비중을 줄였다.

**결과: 틀렸다.** [[event-hbm-demand-strong-2024]]에서 무효화 조건이 그대로 충족되었다.

프로세스 평가: 무효화 조건을 미리 명시한 것은 좋았다 — 덕분에 언제 틀렸는지 명확히 알 수 있었다. 문제는 인과 사슬을 한 단계만 보고 판단한 것이다. "GPU 지연 → HBM 수요 감소"라는 1차 추론에서 멈췄고, 고객사의 재고 전략이라는 2차 효과를 보지 않았다.
