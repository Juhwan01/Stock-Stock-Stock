---
id: company-sk-hynix
type: Company
title: SK하이닉스
ticker: "000660"
market: KOSPI
tags: [반도체, 메모리, HBM]
edges:
  - rel: supplies-to
    to: company-nvidia
    confidence: 0.95
    valid_from: 2023-01-01
    note: HBM3/HBM3E 주력 공급사
  - rel: belongs-to
    to: theme-hbm
---

메모리 반도체 기업. HBM 시장에서 엔비디아향 점유율이 높아 **엔비디아 제품 사이클에 민감**하다.

주의: 이 민감도는 단순 양의 상관이 아니다. [[decision-hynix-reduce-2024]] 참조 — 엔비디아 신제품 지연이 곧바로 HBM 수요 감소를 뜻하지는 않는다.
