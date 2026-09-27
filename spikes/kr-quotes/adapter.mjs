/**
 * 시세 어댑터 — 용도별 계층 분리
 *
 * 리서치 결론: 무료 실시간은 코스콤 독점 구조상 증권사 계좌 없이는 불가능하다.
 * 대신 소스를 하나 고르지 않고 "이 데이터가 어디에 쓰이는가"로 계층을 나눈다.
 *
 *   OFFICIAL  공공데이터포털 금융위 API · KRX Open API    T+1 일별, 약관 명확
 *             → 위키에 영구 저장되는 사실은 여기서만 온다
 *
 *   BEST_EFFORT  Yahoo(20분 지연) · 네이버(~실시간)        무키, 비공식/회색
 *             → 장중 "지금 얼마?" 휘발성 조회 전용. 깨져도 위키 자산은 무사
 *
 *   REALTIME  KIS · 키움 (계좌 필요)                       나중에 어댑터만 추가
 *
 * 핵심 불변식: quote.official === false 인 데이터는 위키에 커밋하지 않는다.
 */

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 소스별 최소 호출 간격 (실측 기반) ──────────────────────────────
// 네이버는 무지연 10연속 10/10 성공했지만 예의상 간격을 둔다.
// 야후는 무지연 15연속 시 IP 단위 429가 7분 이상 지속되므로 반드시 페이싱한다.
const PACING = { naver: 100, toss: 150, daum: 200, yahoo: 1100, datagokr: 100 };
const lastCall = {};

async function paced(source, fn) {
  const wait = (lastCall[source] ?? 0) + PACING[source] - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall[source] = Date.now();
  return fn();
}

async function getJson(url, { lenient = false, headers = {} } = {}) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers } });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  // 네이버 차트 응답은 엄격한 JSON이 아니다 (헤더 행이 작은따옴표)
  return JSON.parse(lenient ? text.replace(/'/g, '"') : text);
}

// ── 소스 구현 ─────────────────────────────────────────────────────

const naver = {
  name: 'naver',
  official: false,
  optIn: true, // 기본 비활성 — 아래 사유
  note:
    '비공식. KRX 시세정보이용정책 §2 [옵션3]은 포털의 시세 화면 표시는 허용하되 ' +
    '"제3자가 전자적으로 가공·저장·재분배할 수 있는 수단(API 등) 제공"을 금지한다. ' +
    '네이버가 공개 API를 두지 않는 것은 기술적 선택이 아니라 라이선스 의무이며, ' +
    '그 내부 엔드포인트를 프로그램으로 긁는 것은 해당 금지를 우회하는 셈이다. ' +
    '사람이 화면을 보는 것은 정상 이용이지만 자동 수집은 다르다. 명시적 opt-in으로만 사용한다.',

  /**
   * polling 엔드포인트를 쓴다. m.stock 의 /basic 을 쓰면 안 되는 이유:
   *   - overMarketPriceInfo 는 시간외에만 존재하고 정규장(09:00~15:30)에는 null이다.
   *   - null이면 최상위 localTradedAt 으로 폴백하는데, 이 필드가 38~252초 지연되고
   *     심지어 최대 61초 역행한다(독립 재현됨). 즉 장중에 가격이 앞뒤로 튄다.
   *   - 앞선 측정의 "0.0분"은 장 마감 후에만 성립하는 값이었다.
   * polling 은 정규장·시간외 모두 delayTime:0 이고 1회 요청에 1,000종목까지 받는다.
   */
  async quote(code) {
    const s = await paced('naver', () =>
      getJson(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`),
    ).then((d) => d?.datas?.[0]);
    if (!s) throw new Error(`종목 없음: ${code}`);

    const over = s.overMarketPriceInfo;
    const live = over?.overMarketStatus === 'OPEN' ? over : null;
    const asOf = new Date(live?.localTradedAt ?? s.localTradedAt);
    return {
      ticker: code,
      name: s.stockName ?? s.itemCode,
      price: Number(String(live?.overPrice ?? s.closePrice).replace(/,/g, '')),
      changePct: Number(live?.fluctuationsRatio ?? s.fluctuationsRatio),
      session: live ? 'after-market' : 'regular',
      asOf,
      lagMinutes: Math.max(0, (Date.now() - asOf.getTime()) / 60000), // 역행 시 음수 방지
      pollingIntervalMs: s.pollingInterval ?? 7000, // 서버가 알려주는 권장 주기를 존중한다
      source: 'naver',
      official: false,
    };
  },

  /** 1회 요청으로 다수 종목 — 관심종목 전체를 한 번에 받는 경로 */
  async quoteMany(codes) {
    const d = await paced('naver', () =>
      getJson(`https://polling.finance.naver.com/api/realtime/domestic/stock/${codes.join(',')}`),
    );
    return (d?.datas ?? []).map((s) => {
      const live = s.overMarketPriceInfo?.overMarketStatus === 'OPEN' ? s.overMarketPriceInfo : null;
      const asOf = new Date(live?.localTradedAt ?? s.localTradedAt);
      return {
        ticker: s.itemCode, name: s.stockName,
        price: Number(String(live?.overPrice ?? s.closePrice).replace(/,/g, '')),
        session: live ? 'after-market' : 'regular', asOf,
        lagMinutes: Math.max(0, (Date.now() - asOf.getTime()) / 60000),
        source: 'naver', official: false,
      };
    });
  },

  async history(code, from = '19990101', to = '20991231') {
    const rows = await paced('naver', () =>
      getJson(
        `https://m.stock.naver.com/front-api/external/chart/domestic/info` +
          `?symbol=${code}&requestType=1&startTime=${from}&endTime=${to}&timeframe=day`,
        { lenient: true },
      ),
    );
    return rows.slice(1).map(([date, open, high, low, close, volume, foreignRatio]) => ({
      date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      open: +open, high: +high, low: +low, close: +close, volume: +volume,
      foreignRatio: +foreignRatio,
      source: 'naver', official: false,
    }));
  },
};

const toss = {
  name: 'toss',
  official: false,
  optIn: true,
  // ⚠️ 다른 비공식 소스보다 리스크 등급이 한 단계 높다.
  // 네이버·다음은 내가 계정을 갖고 있지 않지만, 토스증권은 실제 증권계좌 사업자다.
  // WTS 내부 API를 긁는 최대 오픈소스 래퍼조차 스스로 "토스증권 이용약관 위반에 해당할 수 있으며
  // 계좌 제한·손실에 책임지지 않는다"고 경고한다. 토스 계좌 보유자라면 실자산이 걸린 문제다.
  // 참고: 토스는 2026-08-13 공식 Open API를 출시했다(REST 전용, 계좌 필요). 계좌가 있다면 그쪽을 쓸 것.
  riskLevel: 'elevated',
  note:
    '토스증권 WTS 내부 API — 키·계좌 불필요, KRX+NXT 통합가, 지연 0.2~1초, 네이버와 독립 사업자. ' +
    '단 ⚠️ 토스 계좌 보유자에게는 계좌 제한 리스크가 있다(래퍼 프로젝트들이 스스로 약관 위반 가능성을 경고). ' +
    '계좌가 있다면 2026-08-13 출시된 공식 Open API(https://developers.tossinvest.com)를 쓰는 편이 낫다.',

  async quote(code) {
    const d = await paced('toss', () =>
      getJson(`https://wts-info-api.tossinvest.com/api/v2/stock-prices/A${code}`),
    );
    const r = d?.result ?? d;
    const row = Array.isArray(r) ? r[0] : r;
    const asOf = new Date(row.updatedAt ?? row.tradedAt ?? Date.now());
    return {
      ticker: code, name: row.name ?? code,
      price: Number(row.close ?? row.price),
      changePct: row.changeRate != null ? row.changeRate * 100 : null,
      session: row.exchange === 'integrated' ? 'integrated(KRX+NXT)' : (row.exchange ?? 'regular'),
      asOf,
      lagMinutes: Math.max(0, (Date.now() - asOf.getTime()) / 60000),
      source: 'toss', official: false,
    };
  },
};

const daum = {
  name: 'daum',
  official: false,
  optIn: true, // 네이버와 동일한 포털 라이선스 구조 — 한쪽만 막으면 일관성이 없다
  note: '다음 금융 비공식 — Referer 헤더 필요. 정규장만 제공(시간외 미반영). 라이선스 지위는 네이버와 동일',

  async quote(code) {
    const d = await paced('daum', () =>
      getJson(`https://finance.daum.net/api/quotes/A${code}?summary=false&changeStatistics=true`, {
        headers: { Referer: 'https://finance.daum.net/', 'X-Requested-With': 'XMLHttpRequest' },
      }),
    );
    // date 는 날짜만 담고 있다 — 체결 시각은 tradeDate + tradeTime 조합이다.
    const [, y, mo, dd] = d.tradeDate?.match(/(\d{4})(\d{2})(\d{2})/) ?? [];
    const [, hh, mi, ss] = d.tradeTime?.match(/(\d{2})(\d{2})(\d{2})/) ?? [];
    const asOf = y ? new Date(`${y}-${mo}-${dd}T${hh}:${mi}:${ss}+09:00`) : new Date(d.date);
    return {
      ticker: code, name: d.name, price: d.tradePrice,
      changePct: d.changeRate != null ? d.changeRate * 100 : null,
      session: 'regular', asOf,
      lagMinutes: (Date.now() - asOf.getTime()) / 60000,
      source: 'daum', official: false,
    };
  },
};

const yahoo = {
  name: 'yahoo',
  official: false,
  // 국내 포털 직접 스크래핑보다 한 단계 떨어져 있고, Yahoo ToS가 "개인 이용"을 명시적으로 상정한다.
  // 정당한 경로는 아니지만 KRX 정책 §2 옵션3이 직접 겨냥하는 대상은 아니라 기본 폴백으로만 남긴다.
  note: 'yfinance 계열 — Yahoo ToS상 개인 이용 전제, 20분 지연. IP 단위 429 차단이 공격적',

  async quote(code, market = 'KS') {
    const d = await paced('yahoo', () =>
      getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${code}.${market}?interval=1d&range=1d`),
    );
    const m = d.chart.result[0].meta;
    const asOf = new Date(m.regularMarketTime * 1000);
    // 접미사가 틀려도 200에 엉뚱한 과거 데이터를 준다 — 신선도로 검증한다.
    const lagMinutes = (Date.now() - asOf.getTime()) / 60000;
    if (lagMinutes > 60 * 24 * 5) throw new Error(`신선도 실패: ${lagMinutes.toFixed(0)}분 전 데이터 (심볼 오류 의심)`);
    return {
      ticker: code,
      name: m.shortName ?? m.symbol,
      price: m.regularMarketPrice,
      changePct: null,
      asOf,
      lagMinutes,
      source: 'yahoo',
      official: false,
    };
  },
};

const datagokr = {
  name: 'datagokr',
  official: true,
  note: '공공데이터포털 금융위 주식시세정보 — 자동승인, 이용허락범위 제한 없음, T+1 13시 갱신',

  async history(code, { serviceKey, from, to } = {}) {
    if (!serviceKey) {
      const e = new Error('DATA_GO_KR_KEY 미설정 — https://www.data.go.kr/data/15094808/openapi.do 에서 활용신청(자동승인)');
      e.code = 'NO_KEY';
      throw e;
    }
    const qs = new URLSearchParams({
      serviceKey, resultType: 'json', numOfRows: '1000', likeSrtnCd: code,
      ...(from ? { beginBasDt: from } : {}), ...(to ? { endBasDt: to } : {}),
    });
    const d = await paced('datagokr', () =>
      getJson(`https://apis.data.go.kr/1160100/service/GetStockSecuritiesInfoService/getStockPriceInfo?${qs}`),
    );
    const items = d.response?.body?.items?.item ?? [];
    return items.map((r) => ({
      date: `${r.basDt.slice(0, 4)}-${r.basDt.slice(4, 6)}-${r.basDt.slice(6, 8)}`,
      name: r.itmsNm,
      open: +r.mkp, high: +r.hipr, low: +r.lopr, close: +r.clpr,
      volume: +r.trqu, marketCap: +r.mrktTotAmt, changePct: +r.fltRt,
      source: 'datagokr', official: true,
    }));
  },
};

// ── 계층 해석기 ───────────────────────────────────────────────────

/**
 * 현재가 조회 — 휘발성. 빠른 순으로 폴백한다.
 * 반환값의 official 은 대부분 false이며, 호출자는 이를 위키에 저장하면 안 된다.
 */
export async function quote(code, { prefer = null, allowUnlicensed = false, allowElevatedRisk = false } = {}) {
  const sources = { naver, toss, daum, yahoo };
  // 기본값은 라이선스상 opt-in이 필요한 소스를 제외한다.
  // 사용자가 스스로 켜기 전까지 앱이 알아서 긁지 않는다.
  // riskLevel: 'elevated' 소스는 allowUnlicensed 만으로 켜지지 않는다.
  // 사용자의 실제 증권계좌가 걸린 문제라 한 단계 더 명시적인 동의를 요구한다.
  const chain = prefer ?? Object.entries(sources)
    .filter(([, s]) => (allowUnlicensed || !s.optIn) && (allowElevatedRisk || s.riskLevel !== 'elevated'))
    .map(([n]) => n);
  const errors = [];
  for (const name of chain) {
    const src = sources[name];
    if (src.optIn && !allowUnlicensed && !prefer) continue;
    try {
      return await src.quote(code);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(`현재가 소스 실패 — ${errors.join(' / ')}`);
}

/**
 * 히스토리 조회 — 위키에 축적되는 데이터.
 * 공식 소스를 우선하고, 키가 없을 때만 비공식으로 폴백하되 official=false를 명확히 표시한다.
 */
export async function history(code, { serviceKey = process.env.DATA_GO_KR_KEY, from, to, allowUnlicensed = false } = {}) {
  try {
    const rows = await datagokr.history(code, { serviceKey, from, to });
    if (rows.length) return { rows, source: 'datagokr', official: true, degraded: false };
    throw new Error('빈 응답');
  } catch (e) {
    const why = e.code === 'NO_KEY' ? '공식 키 미설정' : `공식 소스 실패 (${e.message})`;
    if (!allowUnlicensed) {
      const err = new Error(
        `${why}. 히스토리는 위키에 축적되는 정본이므로 비공식 소스로 자동 폴백하지 않는다.\n` +
          `  → 공식 키 발급(둘 다 개인 무료, 5분):\n` +
          `     공공데이터포털  https://www.data.go.kr/data/15094808/openapi.do  (자동승인)\n` +
          `     KRX Open API   https://openapi.krx.co.kr/  (개인 가입 가능, 비상업 한정)\n` +
          `  → 그래도 비공식으로 받으려면 allowUnlicensed: true`,
      );
      err.code = 'NEEDS_OFFICIAL_KEY';
      throw err;
    }
    const rows = await naver.history(code, from, to);
    return { rows, source: 'naver', official: false, degraded: true, reason: why };
  }
}

export const sources = { naver, toss, daum, yahoo, datagokr };
