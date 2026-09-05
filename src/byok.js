// BYOK compatibility surface (qjc fork).
//
// A third-party client that supports "bring your own key" (a base URL plus an
// API key, per provider) cannot satisfy two upstream conditions that Claude
// Code satisfies implicitly:
//
//   * the request `system` must carry the Claude Code marker, or upstream
//     answers with an opaque, headerless 429 — and a client cannot inject a
//     system block from its provider config;
//   * a renderer-context request carries `Origin`, which upstream rejects with
//     400 "Disallowed CORS origin".
//
// Neither is fixable from the client side, so the proxy fixes both — but only
// for traffic arriving on a dedicated path prefix. Claude Code reaches the
// proxy on `/v1/...` and therefore cannot enter this lane at all, which is what
// keeps its request bytes, and with them its prompt-cache keys, untouched. The
// isolation is structural, not a classifier that could misfire.
//
// Everything here is pure: no I/O, no proxy state, no timers.

export const CLAUDE_CODE_SYSTEM_MARKER = "You are Claude Code, Anthropic's official CLI for Claude.";

const DEFAULT_PREFIX = '/byok';
const DEFAULT_MIN_USABLE_ACCOUNTS = 2;
const DEFAULT_MAX_CONCURRENT = 2;
const RETRY_AFTER_SECONDS = 5;

// Headers a browser-context client attaches that upstream refuses. They are
// dropped from the outbound request rather than answered with CORS response
// headers: the goal is to look like a CLI to upstream, not to make the proxy
// browser-reachable.
const BROWSER_HEADERS = Object.freeze([
  'origin',
  'referer',
  'cookie',
]);

// Whole families a browser attaches. Enumerating them by prefix keeps the list
// honest as browsers add members (sec-ch-ua-platform-version and friends).
const BROWSER_HEADER_PREFIXES = Object.freeze(['sec-fetch-', 'sec-ch-', 'x-forwarded-']);

// The key shipped in config.example.json. Refusing it is not paranoia: the
// preflight answers any origin, so an unrotated default would let a page the
// user merely visits spend the pool (it could not read the reply, but the
// request would still be served).
const PLACEHOLDER_API_KEYS = Object.freeze(['byok-change-me-to-a-secret']);
const MIN_API_KEY_LENGTH = 20;

const PREFLIGHT_HEADERS = Object.freeze({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers':
    'authorization, content-type, x-api-key, anthropic-version, anthropic-beta, '
    + 'anthropic-dangerous-direct-browser-access',
  'access-control-max-age': '86400',
  'content-length': '0',
});

function disabledConfig(error = null) {
  return { enabled: false, error };
}

// First path segments the proxy already owns. A prefix that collides with one
// of them would pull real Claude Code traffic into the BYOK lane, which is the
// one thing this design must make impossible.
const RESERVED_FIRST_SEGMENTS = Object.freeze(['v1', 'teamclaude']);

function normalizePrefix(raw) {
  if (raw == null) return DEFAULT_PREFIX;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  const prefixed = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  const firstSegment = prefixed.split('/')[1];
  if (!firstSegment || RESERVED_FIRST_SEGMENTS.includes(firstSegment)) return null;
  return prefixed;
}

// Fail closed on dot-segments (raw or percent-encoded): the canonicalized path
// is only ever used to build the upstream URL, but a "/byok/../teamclaude/..."
// shaped request must not be given the benefit of the doubt.
export function hasUnsafeSegments(path) {
  if (typeof path !== 'string' || !path) return true;
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return true;
  }
  const [pathname] = decoded.split(/[?#]/);
  return pathname.split('/').some(segment => segment === '.' || segment === '..');
}

function clampInt(value, fallback, min) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

// Returns { enabled: false, error } or a fully normalized config. Enabling
// without a key is refused rather than silently downgraded: the surface must
// not inherit the localhost auth bypass, since any local process can reach it.
export function normalizeByokConfig(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return disabledConfig();
  const apiKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
  if (!apiKey) return disabledConfig('byok.apiKey is required to enable the BYOK surface');
  if (PLACEHOLDER_API_KEYS.includes(apiKey) || apiKey.toLowerCase().includes('change-me')) {
    return disabledConfig('byok.apiKey is still the config.example.json placeholder — set a unique secret');
  }
  if (apiKey.length < MIN_API_KEY_LENGTH) {
    return disabledConfig(`byok.apiKey must be at least ${MIN_API_KEY_LENGTH} characters`);
  }
  const prefix = normalizePrefix(raw.prefix);
  if (!prefix) return disabledConfig('byok.prefix must be a non-root path such as "/byok"');
  return {
    enabled: true,
    error: null,
    prefix,
    apiKey,
    minUsableAccounts: clampInt(raw.minUsableAccounts, DEFAULT_MIN_USABLE_ACCOUNTS, 0),
    maxConcurrent: clampInt(raw.maxConcurrent, DEFAULT_MAX_CONCURRENT, 1),
  };
}

// Canonicalize a BYOK request path back to the upstream path, or return null
// when the request is not on the surface. Matching is segment-exact so a
// neighbouring path like "/byokish/..." cannot slip into the lane.
// Duplicate slashes are collapsed so the downstream reachability checks are
// exact-match on a canonical string. Without this, "/byok//teamclaude/status"
// would slip past a startsWith('/teamclaude/') gate and the isolation would
// hold only because unrelated code elsewhere happens to compare exactly.
function collapseSlashes(path) {
  const queryAt = path.indexOf('?');
  if (queryAt === -1) return path.replace(/\/{2,}/g, '/');
  const pathname = path.slice(0, queryAt).replace(/\/{2,}/g, '/');
  return `${pathname}${path.slice(queryAt)}`;
}

export function matchByokSurface(url, prefix) {
  if (typeof url !== 'string' || !url) return null;
  if (typeof prefix !== 'string' || !prefix) return null;
  if (!url.startsWith(prefix)) return null;
  const rest = url.slice(prefix.length);
  if (rest && rest[0] !== '/' && rest[0] !== '?') return null;
  if (!rest || rest === '/') return { path: '/' };
  return { path: collapseSlashes(rest[0] === '?' ? `/${rest}` : rest) };
}

function markerPresent(system) {
  if (typeof system === 'string') return system.includes(CLAUDE_CODE_SYSTEM_MARKER);
  if (!Array.isArray(system)) return false;
  return system.some((block) => block
    && typeof block === 'object'
    && typeof block.text === 'string'
    && block.text.includes(CLAUDE_CODE_SYSTEM_MARKER));
}

// The client's own system content is preserved after the marker — upstream only
// requires that the marker be present, and the client's prompt still has to do
// its job.
function withMarker(system) {
  if (system == null) return CLAUDE_CODE_SYSTEM_MARKER;
  if (typeof system === 'string') {
    return system.trim()
      ? `${CLAUDE_CODE_SYSTEM_MARKER}\n\n${system}`
      : CLAUDE_CODE_SYSTEM_MARKER;
  }
  if (Array.isArray(system)) {
    return [{ type: 'text', text: CLAUDE_CODE_SYSTEM_MARKER }, ...system];
  }
  return system; // unknown shape — leave it for upstream to reject verbatim
}

export function scrubBrowserHeaders(headers) {
  const removed = [];
  if (!headers || typeof headers !== 'object') return removed;
  for (const name of Object.keys(headers)) {
    const lower = name.toLowerCase();
    const matches = BROWSER_HEADERS.includes(lower)
      || BROWSER_HEADER_PREFIXES.some(prefix => lower.startsWith(prefix));
    if (matches) {
      delete headers[name];
      removed.push(lower);
    }
  }
  return removed;
}

// Normalize one BYOK request. Returns the original buffer untouched whenever
// nothing needs to change (unparseable body, non-object JSON, marker already
// present), so an already-correct client pays no re-serialization and no
// byte-level difference.
export function applyByokRequest(req, body) {
  const scrubbed = scrubBrowserHeaders(req?.headers);
  let json;
  try {
    json = JSON.parse(body.toString());
  } catch {
    return { body, injected: false, scrubbed };
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return { body, injected: false, scrubbed };
  }
  if (markerPresent(json.system)) return { body, injected: false, scrubbed };
  const nextSystem = withMarker(json.system);
  if (nextSystem === json.system) return { body, injected: false, scrubbed };
  json.system = nextSystem;
  const rewritten = Buffer.from(JSON.stringify(json));
  // content-length is forwarded verbatim (it is not hop-by-hop), so a stale
  // value would make undici reject the request outright.
  if (req?.headers) req.headers['content-length'] = String(rewritten.length);
  return { body: rewritten, injected: true, scrubbed };
}

// Answer a preflight locally. Relaying OPTIONS upstream fails, and the client
// only needs the browser to stop blocking the real request.
export function answerByokPreflight(req, res) {
  if (!req || req.method !== 'OPTIONS') return false;
  res.writeHead(204, { ...PREFLIGHT_HEADERS });
  res.end();
  return true;
}

// Admission control. BYOK traffic shares the same account pool as Claude Code,
// which has no per-client quota reservation, so a BYOK client must yield while
// the pool is thin and must not occupy more than its own concurrency slice.
export function admitByok({ usableCount, byokInflight, config } = {}) {
  const minUsableAccounts = Number.isFinite(config?.minUsableAccounts)
    ? config.minUsableAccounts
    : DEFAULT_MIN_USABLE_ACCOUNTS;
  const maxConcurrent = Number.isFinite(config?.maxConcurrent)
    ? config.maxConcurrent
    : DEFAULT_MAX_CONCURRENT;
  if (Number.isFinite(usableCount) && usableCount < minUsableAccounts) {
    return { ok: false, reason: 'headroom', retryAfter: RETRY_AFTER_SECONDS };
  }
  if (Number.isFinite(byokInflight) && byokInflight >= maxConcurrent) {
    return { ok: false, reason: 'concurrency', retryAfter: RETRY_AFTER_SECONDS };
  }
  return { ok: true, reason: null, retryAfter: 0 };
}
