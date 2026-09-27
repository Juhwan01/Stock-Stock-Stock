---
id: event-blackwell-delay-2024
type: Event
title: 엔비디아 블랙웰 설계 결함·출시 지연 보도
date: 2024-08-03
tags: [반도체, HBM, 신제품지연, 공급망]
sources:
  - "https://www.theinformation.com/articles/nvidia-blackwell-delay"
edges:
  - rel: affects
    to: company-sk-hynix
    direction: "-"
    confidence: 0.6
    valid_from: 2024-08-03
    valid_until: 2024-11-20
    note: 블랙웰 지연 시 HBM3E 수요가 이연될 것이라는 당시 판단. 2024-11 실적으로 반증됨.
  - rel: affects
    to: company-nvidia
    direction: "-"
    confidence: 0.8
    valid_from: 2024-08-03
  - rel: belongs-to
    to: theme-hbm
---

엔비디아 차세대 GPU 블랙웰의 설계 결함으로 양산이 최대 1개 분기 지연될 수 있다는 보도가 나왔다.

당시 시장의 지배적 해석은 **"GPU가 늦어지면 함께 실리는 HBM 수요도 이연된다"**는 것이었고, HBM 공급사 주가가 동반 하락했다.

이 해석은 [[event-hbm-demand-strong-2024]]에서 반증되었다. 나의 대응은 [[decision-hynix-reduce-2024]]에 기록되어 있다.
