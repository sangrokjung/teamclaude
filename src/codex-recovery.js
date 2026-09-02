import { isCodexSessionId } from './codex-session.js';

export const CODEX_INVOCATION_HEADER = 'x-teamcodex-invocation';
export const CODEX_RECOVERY_SESSION_HEADER = 'x-teamcodex-recovery-session';
export const CODEX_RECOVERY_CONSUME_PATH = '/teamclaude/codex-recovery/consume';

const INVOCATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCodexInvocationId(value) {
  return typeof value === 'string' && INVOCATION_ID.test(value);
}

export function codexRecoveryIdentity(headers, body) {
  const invocationId = headers?.[CODEX_INVOCATION_HEADER];
  if (!isCodexInvocationId(invocationId)) return null;
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const sessionId = value?.prompt_cache_key;
  return isCodexSessionId(sessionId) ? { invocationId, sessionId } : null;
}

export function isCodexResponsesPath(path) {
  if (typeof path !== 'string') return false;
  const pathname = path.split('?', 1)[0].replace(/\/+$/, '');
  return pathname === '/codex/responses' || pathname === '/responses';
}
