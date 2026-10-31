// Claude API 단가표 (qjc fork). API 키 계정의 추정 지출을 계산한다.
//
// 추정은 계정을 막지 않는다. 실제 거절(크레딧 소진 응답)만 계정을 뺀다. 그래서
// 단가표가 틀려도 과금 위험은 없고 화면의 "남은 금액 약 $X"만 틀린다.
//
// 출처: Anthropic 공개 모델 가격표(1M 토큰당 USD). 4.5 이하 값은 2026-02-03 시점,
// Fable 5·5.1, Mythos 5.1, Opus 4.6~5.5, Sonnet 4.6~5.5, Haiku 5.5 값은 claude-api
// 스킬의 현행 모델 표(2026-10-06 캐시)로 넣었다. 표에 없는 모델의 토큰은 unpriced로
// 따로 센다. 운영자는 `config.apiPricing`으로 단가를 넣거나 고친다.
//
// 캐시 단가는 공개 규칙(입력 단가 기준 5분 쓰기 1.25배, 1시간 쓰기 2배, 읽기
// 0.1배)으로 만든다. 가격표가 캐시 읽기를 따로 밝힌 모델(Fable 5.1·Mythos 5.1
// $0.25, Opus 5.5 $0.20)은 그 값을 쓴다. Haiku 5.5의 100K 초과 입력 할증은
// 반영하지 않는다. 단순화: 장문 맥락(200K 초과 입력) 할증과 배치 할인은 반영하지
// 않는다. 할증이 붙는 요청은 실제보다 적게 추정된다. 업그레이드 경로는 응답의
// 입력 토큰 수로 할증 구간을 판정하는 것.
//
// 순수 모듈: I/O·상태·타이머 없음.

const CACHE_WRITE_5M_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_MULTIPLIER = 2;
const CACHE_READ_MULTIPLIER = 0.1;
const PER_TOKEN = 1 / 1_000_000;

// 입력·출력 단가(1M 토큰당 USD). 키는 normalizeModelName을 거친 이름이다.
// 세 번째 칸은 가격표가 따로 밝힌 캐시 단가(fullPrice의 extra)다.
const BASE_PRICES = Object.freeze({
  'claude-fable-5-1': [10, 50, { cacheRead: 0.25 }],
  'claude-mythos-5-1': [10, 50, { cacheRead: 0.25 }],
  'claude-fable-5': [10, 50],
  'claude-opus-5-5': [4, 20, { cacheRead: 0.2 }],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5-5': [2, 10],
  'claude-sonnet-5': [2, 10],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-opus-4-5': [5, 25],
  'claude-opus-4-1': [15, 75],
  'claude-opus-4': [15, 75],
  'claude-sonnet-4-5': [3, 15],
  'claude-sonnet-4': [3, 15],
  'claude-haiku-4-5': [1, 5],
  'claude-3-7-sonnet': [3, 15],
  'claude-3-5-sonnet': [3, 15],
  'claude-3-5-haiku': [0.8, 4],
  'claude-3-opus': [15, 75],
  'claude-3-haiku': [0.25, 1.25],
});

function isPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function fullPrice(input, output, extra = {}) {
  return {
    input,
    output,
    cacheWrite5m: isPrice(extra.cacheWrite5m) ? extra.cacheWrite5m : input * CACHE_WRITE_5M_MULTIPLIER,
    cacheWrite1h: isPrice(extra.cacheWrite1h) ? extra.cacheWrite1h : input * CACHE_WRITE_1H_MULTIPLIER,
    cacheRead: isPrice(extra.cacheRead) ? extra.cacheRead : input * CACHE_READ_MULTIPLIER,
  };
}

const DEFAULT_TABLE = Object.freeze(Object.fromEntries(
  Object.entries(BASE_PRICES).map(([model, [input, output, extra]]) => [model, Object.freeze(fullPrice(input, output, extra))]),
));

/**
 * 모델 이름을 단가표 키 모양으로 바꾼다: 소문자, `[1m]` 같은 대괄호 접미,
 * `-v1:0` 배포 접미, `-YYYYMMDD` 날짜, `-latest`를 뗀다.
 */
export function normalizeModelName(model) {
  if (typeof model !== 'string') return null;
  let name = model.trim().toLowerCase();
  name = name.replace(/\[[^\]]*\]$/, '');
  name = name.replace(/-v\d+(?::\d+)?$/, '');
  name = name.replace(/-\d{8}$/, '');
  name = name.replace(/-latest$/, '');
  return name || null;
}

/**
 * `config.apiPricing`({ 모델: { input, output, cacheWrite5m?, cacheWrite1h?, cacheRead? } })
 * 를 검증한다. input·output이 0 이상의 수가 아닌 항목은 버린다. 빠진 캐시 단가는
 * 입력 단가의 배수로 채운다.
 */
export function normalizeApiPricing(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const table = {};
  for (const [model, entry] of Object.entries(raw)) {
    const key = normalizeModelName(model);
    if (!key || !entry || typeof entry !== 'object') continue;
    if (!isPrice(entry.input) || !isPrice(entry.output)) continue;
    table[key] = fullPrice(entry.input, entry.output, entry);
  }
  return table;
}

// 단순화: 접두 일치는 숫자 버전 경계를 넘지 않는다. `claude-opus-4` 단가가
// 새 모델 `claude-opus-4-8`을 잡으면 3배 넘게 틀린 추정이 나오기 때문이다.
// 숫자가 아닌 꼬리(`-preview` 등)만 같은 모델의 변형으로 본다.
function prefixMatches(name, key) {
  if (name === key) return true;
  if (!name.startsWith(`${key}-`)) return false;
  return !/^-\d/.test(name.slice(key.length));
}

/**
 * 모델의 단가(1M 토큰당 USD)를 찾는다. `overrides`는 normalizeApiPricing 결과.
 * 같은 키면 덮어쓰기가 이기고, 그다음 가장 긴 접두가 이긴다. 모르면 null.
 */
export function resolveApiPrice(model, overrides = {}) {
  const name = normalizeModelName(model);
  if (!name) return null;
  const table = { ...DEFAULT_TABLE, ...(overrides || {}) };
  let best = null;
  for (const key of Object.keys(table)) {
    if (!prefixMatches(name, key)) continue;
    if (best === null || key.length > best.length) best = key;
  }
  return best === null ? null : { ...table[best] };
}

function tokenCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * 응답 `usage` 한 건의 비용. 반환값 { priced, usd, tokens }: tokens는 입력·캐시
 * 쓰기·캐시 읽기·출력의 합이다. 단가를 모르면 priced false, usd 0.
 * `cache_creation`의 5분·1시간 분리 필드가 있으면 그것을 쓰고, 합계와의 차이는
 * 5분 단가로 센다.
 */
export function computeApiCost(usage, model, overrides = {}) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const input = tokenCount(u.input_tokens);
  const cacheWriteTotal = tokenCount(u.cache_creation_input_tokens);
  const cacheRead = tokenCount(u.cache_read_input_tokens);
  const output = tokenCount(u.output_tokens);
  let write1h = 0;
  let write5m = cacheWriteTotal;
  if (u.cache_creation && typeof u.cache_creation === 'object') {
    const split5m = tokenCount(u.cache_creation.ephemeral_5m_input_tokens);
    write1h = tokenCount(u.cache_creation.ephemeral_1h_input_tokens);
    write5m = split5m + Math.max(0, cacheWriteTotal - split5m - write1h);
  }
  const tokens = input + write5m + write1h + cacheRead + output;
  const price = resolveApiPrice(model, overrides);
  if (!price) return { priced: false, usd: 0, tokens };
  const usd = (input * price.input
    + write5m * price.cacheWrite5m
    + write1h * price.cacheWrite1h
    + cacheRead * price.cacheRead
    + output * price.output) * PER_TOKEN;
  return { priced: true, usd, tokens };
}
