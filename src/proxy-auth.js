// Public-listener authentication helpers for the supervisor.
//
// Remote (non-loopback) callers must present proxy.apiKey. When that key is
// missing, empty, or not a string, remote requests fail closed: there is no
// "no key configured, so let everyone in" mode. Loopback callers keep their
// key-less access.

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** True only for the exact loopback forms a local socket reports. */
export function isLoopbackAddress(addr) {
  return typeof addr === 'string' && LOOPBACK_ADDRESSES.has(addr);
}

/**
 * Whether a request may pass the proxy API key gate.
 * Loopback requests always pass; remote ones need a configured, non-empty
 * string key matched by `x-api-key` or a Bearer token.
 */
export function isRemoteAuthorized({ isLocal, proxyApiKey, clientKey, bearerKey }) {
  if (isLocal) return true;
  if (typeof proxyApiKey !== 'string' || proxyApiKey.length === 0) return false;
  return clientKey === proxyApiKey || bearerKey === proxyApiKey;
}
