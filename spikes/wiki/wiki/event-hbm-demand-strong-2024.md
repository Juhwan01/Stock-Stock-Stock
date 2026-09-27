---
id: event-hbm-demand-strong-2024
type: Event
title: SK하이닉스 HBM 수요 견조 확인 (3분기 실적)
date: 2024-11-20
tags: [반도체, HBM, 실적]
sources:
  - "https://dart.fss.or.kr"
edges:
  - rel: invalidated-by
    to: event-blackwell-delay-2024
    note: 신제품 지연이 HBM 수요 이연으로 직결된다는 가정을 반증
  - rel: affects
    to: company-sk-hynix
    direction: "+"
    confidence: 0.9
    valid_from: 2024-11-20
  - rel: belongs-to
    to: theme-hbm
---

SK하이닉스 실적에서 HBM 매출이 오히려 증가했다. 블랙웰 지연에도 불구하고 기존 H100/H200 라인의 HBM3E 수요가 견조했고, 고객사가 **선제적 재고 확보**에 나섰기 때문이다.

핵심 교훈: 최종 제품(GPU)의 지연이 부품(HBM) 수요 감소로 직결되지 않는다. 오히려 공급 부족 우려가 선주문을 유발할 수 있다.
