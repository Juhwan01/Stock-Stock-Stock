---
id: event-rubin-delay-rumor-2026
type: Event
title: 엔비디아 루빈 차세대 플랫폼 양산 지연 루머
date: 2026-08-18
tags: [반도체, HBM, 신제품지연, 공급망]
sources:
  - "https://example.com/rumor"
edges:
  - rel: affects
    to: company-sk-hynix
    direction: "-"
    confidence: 0.3
    valid_from: 2026-08-18
    note: 2024년 블랙웰 사례를 고려해 확신도를 낮게 잡음
  - rel: similar-to
    to: event-blackwell-delay-2024
    note: 동일 패턴 — 엔비디아 신제품 지연 → HBM 공급사 동반 하락
  - rel: belongs-to
    to: theme-hbm
---

엔비디아 루빈 플랫폼의 양산 일정이 밀린다는 루머가 돌며 HBM 공급사 주가가 장중 하락했다.

**2024년 블랙웰 때와 구조적으로 동일한 상황이다.** 과거 케이스는 [[event-blackwell-delay-2024]]와 [[decision-hynix-reduce-2024]]를 참조할 것.
