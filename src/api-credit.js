// API 키 계정 크레딧 도우미 (qjc fork). Anthropic 모드의 `type: 'apikey'` 계정만
// 대상이다. 설정 필드 정규화, 상류 크레딧 거절 판별, 상태 응답 credit 블록.
//
// 순수 모듈: I/O·상태·타이머 없음. 키 값은 읽지도 돌려주지도 않는다.

export const CREDIT_EXHAUSTED_REASONS = Object.freeze(['credit-exhausted', 'usage-limit', 'spend-limit', 'billing']);
const DEFAULT_REASON = 'credit-exhausted';

/** 유료 계층 대상: Anthropic 모드 API 키 계정. Codex 풀의 키는 대상이 아니다. */
export function isApiKeyAccount(account) {
  return Boolean(account) && account.type === 'apikey' && (account.provider || 'anthropic') === 'anthropic';
}

export function normalizeCreditUsd(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function normalizeCreditTimestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** `{ reason, at }` 또는 null. `true`는 사유 미상 소진으로 받는다. */
export function normalizeCreditExhausted(raw) {
  if (raw === true) return { reason: DEFAULT_REASON, at: null };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const reason = CREDIT_EXHAUSTED_REASONS.includes(raw.reason) ? raw.reason : DEFAULT_REASON;
  return { reason, at: normalizeCreditTimestamp(raw.at) };
}

/** 설정 계정 하나에서 크레딧 설정 필드를 읽는다(소진 플래그 제외). */
export function readCreditConfig(source = {}) {
  return {
    creditUsd: normalizeCreditUsd(source.creditUsd),
    creditSince: normalizeCreditTimestamp(source.creditSince),
    creditExpiresAt: normalizeCreditTimestamp(source.creditExpiresAt),
  };
}

function parseErrorBody(body) {
  if (body == null) return null;
  try {
    const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
    const json = JSON.parse(text);
    return json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error : null;
  } catch {
    return null;
  }
}

// 400 메시지 판정은 상류 문서의 문장으로 "시작하는" 경우만 인정한다. 400 오류
// 메시지에는 클라이언트가 보낸 요청 내용이 섞여 돌아올 수 있어서, 부분 포함으로
// 판정하면 프롬프트에 이 문구를 넣는 것만으로 멀쩡한 키를 영구로 뺄 수 있다.
const CREDIT_LOW_MESSAGE = /^your credit balance is too low to access the anthropic api/i;
const USAGE_LIMIT_MESSAGE = /^you have reached your specified api usage limits/i;

// 메시지 문장으로만 판정한 사유. 구조화 신호(402 billing_error, 429 error_code)와
// 달리 요청 내용의 영향을 받을 수 있어 서버가 요청당 영속 처리 수를 제한한다.
const MESSAGE_BASED_REASONS = new Set(['credit-exhausted', 'usage-limit']);

export function isMessageBasedCreditReason(reason) {
  return MESSAGE_BASED_REASONS.has(reason);
}

/**
 * 상류 응답이 API 키의 크레딧 거절인지 판별한다. 사유 문자열 또는 null.
 * 문구가 바뀌어 놓치면 지금처럼 오류가 클라이언트에 가는 쪽으로 떨어질 뿐이다.
 */
export function classifyCreditRefusal(status, body) {
  if (status !== 400 && status !== 402 && status !== 429) return null;
  const error = parseErrorBody(body);
  if (!error) return null;
  if (status === 400) {
    if (error.type !== 'invalid_request_error' || typeof error.message !== 'string') return null;
    if (CREDIT_LOW_MESSAGE.test(error.message)) return 'credit-exhausted';
    if (USAGE_LIMIT_MESSAGE.test(error.message)) return 'usage-limit';
    return null;
  }
  if (status === 429) {
    return error.details && typeof error.details === 'object'
      && error.details.error_code === 'enforced_spend_limit_reached' ? 'spend-limit' : null;
  }
  return error.type === 'billing_error' ? 'billing' : null;
}

function compactUsd(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100 || Number.isInteger(n)) return String(Math.round(n));
  return n.toFixed(1);
}

/**
 * TUI 칸에 들어가는 짧은 표기: `$남은/충전`(추정, 0 미만은 0), 소진이면 `out`,
 * 충전 금액이 없으면 `sp $지출`. credit 블록이 없으면 `-`.
 */
export function formatApiCreditCompact(credit) {
  if (!credit || typeof credit !== 'object') return '-';
  if (credit.exhausted === true) return 'out';
  const spent = Number.isFinite(credit.spentUsd) ? credit.spentUsd : 0;
  if (!Number.isFinite(credit.usd)) return `sp $${compactUsd(spent)}`;
  return `$${compactUsd(Math.max(0, credit.usd - spent))}/${compactUsd(credit.usd)}`;
}

/** 상태 응답용 credit 블록. 키 값·키 일부는 넣지 않는다. */
export function creditStatus(account) {
  const usd = account.creditUsd ?? null;
  const spentUsd = Number.isFinite(account.quota?.apiSpendUsd) ? account.quota.apiSpendUsd : 0;
  return {
    usd,
    spentUsd,
    remainingUsd: usd == null ? null : usd - spentUsd,
    since: account.creditSince ?? null,
    expiresAt: account.creditExpiresAt ?? null,
    exhausted: Boolean(account.creditExhausted),
    exhaustedReason: account.creditExhausted?.reason ?? null,
    unpricedTokens: Number.isFinite(account.quota?.apiUnpricedTokens) ? account.quota.apiUnpricedTokens : 0,
  };
}
