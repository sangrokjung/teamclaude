import http from 'node:http';
import https from 'node:https';
import { mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  brotliDecompressSync,
  createBrotliDecompress,
  createGunzip,
  createInflate,
  gunzipSync,
  inflateSync,
} from 'node:zlib';
import { isTokenExpiringSoon, normalizeExpiresAt } from './oauth.js';
import { modelQuotaLabel } from './account-manager.js';
import { createHostTracker } from './system-metrics.js';
import { SseFramer, sseErrorEvent, isEventStream } from './sse.js';
import { normalizeContinuityMaxWaitMs } from './config.js';
import {
  applyCodexResetCreditOutcome,
  codexResetCreditEligibility,
  codexResetCreditOutcomeKind,
  consumeCodexResetCredit,
  describeCodexResetCreditCandidates,
  normalizeCodexResetCreditsConfig,
  rankCodexResetCreditCandidates,
  withinCodexResetCreditGrace,
} from './codex-reset-credits.js';
import {
  CODEX_INVOCATION_HEADER,
  CODEX_RECOVERY_SESSION_HEADER,
  codexRecoveryIdentity,
  isCodexResponsesPath,
} from './codex-recovery.js';
import {
  hasClaudeRecoveryMarker,
  parseClaudeRecoveryAccount,
} from './claude-auth.js';


const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-connection',
  'proxy-authorization', 'proxy-authenticate',
]);
const CODEX_ERROR_INSPECTION_MAX_BYTES = 16 * 1024;

function connectionHeaderNames(value) {
  return new Set(
    String(value || '').split(',').map(name => name.trim().toLowerCase()).filter(Boolean),
  );
}

function requestUpstreamRaw(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.request(parsed, { method, headers, signal }, response => {
      const responseHeaders = new Headers();
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
      }
      resolve({
        status: response.statusCode || 502,
        headers: responseHeaders,
        body: Readable.toWeb(response),
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

function decodeBodyForInspection(body, contentEncoding, maxBytes) {
  if (body.length > maxBytes) return null;
  const encodings = String(contentEncoding || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(value => value && value !== 'identity');
  let decoded = body;
  try {
    for (const encoding of encodings.reverse()) {
      const options = { maxOutputLength: maxBytes };
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        decoded = gunzipSync(decoded, options);
      } else if (encoding === 'deflate') {
        decoded = inflateSync(decoded, options);
      } else if (encoding === 'br') {
        decoded = brotliDecompressSync(decoded, options);
      } else {
        return null;
      }
      if (decoded.length > maxBytes) return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function createEncodedSseObserver(contentEncoding, reserveBytes, releaseBytes) {
  const encodings = String(contentEncoding || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(value => value && value !== 'identity');
  if (encodings.length !== 1) return null;

  let decoder;
  if (encodings[0] === 'gzip' || encodings[0] === 'x-gzip') decoder = createGunzip();
  else if (encodings[0] === 'deflate') decoder = createInflate();
  else if (encodings[0] === 'br') decoder = createBrotliDecompress();
  else return null;

  const framer = new SseFramer({ reserveBytes, releaseBytes });
  let failed = false;
  let settled = false;
  let resolveFinished;
  const finished = new Promise(resolve => { resolveFinished = resolve; });
  const settle = didFail => {
    failed ||= didFail;
    if (settled) return;
    settled = true;
    resolveFinished();
  };

  decoder.on('data', chunk => {
    if (failed) return;
    const frames = framer.push(chunk);
    if (framer.limitExceeded) {
      failed = true;
      decoder.destroy();
      return;
    }
    if (frames?.length) framer.releaseForwarded(frames.length);
  });
  decoder.once('end', () => settle(false));
  decoder.once('error', () => settle(true));
  decoder.once('close', () => settle(!decoder.readableEnded));

  return {
    async push(chunk) {
      if (failed || decoder.destroyed || decoder.writableEnded) return;
      if (decoder.write(chunk)) return;
      await Promise.race([
        new Promise(resolve => decoder.once('drain', resolve)),
        finished,
      ]);
    },
    async finish() {
      if (!failed && !decoder.destroyed && !decoder.writableEnded) decoder.end();
      await finished;
    },
    get sawResponseCompleted() {
      return !failed && framer.sawResponseCompleted;
    },
    dispose() {
      decoder.destroy();
      framer.dispose();
    },
  };
}

function isCodexInferenceRequest(req) {
  if (req.method !== 'POST') return false;
  const path = req.url.split('?')[0];
  return /^\/(?:codex\/)?responses(?:\/compact)?$/.test(path);
}

function isCompletedCodexResponse(body) {
  if (!body?.length) return false;
  try {
    const response = JSON.parse(body.toString('utf8'));
    return typeof response?.id === 'string' && response.id.length > 0
      && response.object === 'response'
      && response.status === 'completed';
  } catch {
    return false;
  }
}

// Legacy ceiling for model-tier polling when continuityMaxWaitMs is 0. Deadline
// mode uses the request's overall continuity deadline instead.
const MODEL_EXHAUST_WAIT_PASSES = 10;
const TRANSACTION_MEMORY_BYTES = 1024 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_STREAM_TOTAL_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_BUFFERED_REQUEST_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_BUFFERED_RESPONSE_BYTES = 256 * 1024 * 1024;
const REQUEST_LOG_BODY_BYTES = 16 * 1024;

export function createProxyServer(accountManager, config, hooks = {}) {
  const provider = config.provider === 'codex' ? 'codex' : 'anthropic';
  const upstream = config.upstream || (provider === 'codex'
    ? 'https://chatgpt.com/backend-api/codex'
    : 'https://api.anthropic.com');
  const hostTracker = createHostTracker(); // host CPU/RAM for /teamclaude/status
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  // How long a request may wait for a per-account concurrency slot to free when
  // every available account is at its cap, before giving up with a 429. 0 = never
  // queue (fail fast). Default 15s.
  const queueTimeoutMs = Number.isFinite(config.overflowQueueTimeoutMs)
    ? Math.max(0, config.overflowQueueTimeoutMs)
    : 15000;
  // Cap the buffered request body. The proxy must buffer the whole body to replay
  // it across accounts on a 429/5xx, so an unbounded body is an unbounded buffer.
  const maxBodyBytes = Number.isFinite(config.maxRequestBytes) && config.maxRequestBytes > 0
    ? config.maxRequestBytes
    : 32 * 1024 * 1024;
  const requestBodyTimeoutMs = Number.isFinite(config.requestBodyTimeoutMs)
      && config.requestBodyTimeoutMs > 0
    ? Math.max(1, Math.floor(config.requestBodyTimeoutMs))
    : 30_000;
  const maxBufferedRequestBytes = Number.isFinite(config.maxBufferedRequestBytes)
      && config.maxBufferedRequestBytes > 0
    ? config.maxBufferedRequestBytes
    : DEFAULT_MAX_BUFFERED_REQUEST_BYTES;
  const supervisedWorker = Boolean(process.env.TEAMCLAUDE_SUPERVISOR_PID);
  // Connection affinity: keep one client connection's sequential requests on the
  // same account for prompt-cache locality (HTTP/1.1 keep-alive reuses the socket
  // for a session's sequential turns). Soft — overflow still spreads. Set
  // `sessionAffinity: false` to route purely by use-or-lose every request instead.
  const sessionAffinity = config.sessionAffinity !== false;
  // Continuity mode keeps Claude Code requests inside the proxy while capacity
  // or upstream rate limits recover, instead of surfacing a terminal-stopping
  // 429. Unit tests can leave it off; the CLI server enables it by default.
  const continuityMode = config.continuityMode === true;
  const continuityMaxWaitMs = normalizeContinuityMaxWaitMs(config.continuityMaxWaitMs);
  const continuityMaxSleepMs = Number.isFinite(config.continuityMaxSleepMs)
    ? Math.max(10, config.continuityMaxSleepMs)
    : 30_000;
  const continuityJitterMs = Number.isFinite(config.continuityJitterMs)
    ? Math.max(0, config.continuityJitterMs)
    : 500;
  const rateLimitFailovers = Number.isFinite(config.rateLimitFailovers)
    ? Math.max(0, Math.floor(config.rateLimitFailovers))
    : 1;
  // Mid-stream recovery: relay SSE one whole event at a time and convert an
  // abnormal upstream end (network death / silent truncation without a terminal
  // event) into a well-formed retryable `overloaded_error` SSE event instead of
  // killing the client socket. Claude Code auto-retries that; it does NOT retry
  // a raw mid-stream connection loss ("Connection closed mid-response").
  // Anthropic-only: the Codex backend's in-stream error contract differs, so
  // codex mode keeps the legacy passthrough. `streamRecovery: false` opts out.
  const streamRecovery = provider === 'anthropic' && config.streamRecovery !== false;
  const maxResponseBytes = Number.isFinite(config.maxResponseBytes) && config.maxResponseBytes > 0
    ? Math.floor(config.maxResponseBytes)
    : DEFAULT_MAX_RESPONSE_BYTES;
  const maxBufferedResponseBytes = Number.isFinite(config.maxBufferedResponseBytes)
      && config.maxBufferedResponseBytes > 0
    ? Math.floor(config.maxBufferedResponseBytes)
    : DEFAULT_MAX_BUFFERED_RESPONSE_BYTES;
  const upstreamResponseTimeoutMs = Number.isFinite(config.upstreamResponseTimeoutMs)
      && config.upstreamResponseTimeoutMs > 0
    ? Math.floor(config.upstreamResponseTimeoutMs)
    : DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS;
  const streamIdleTimeoutMs = Number.isFinite(config.streamIdleTimeoutMs)
      && config.streamIdleTimeoutMs > 0
    ? Math.floor(config.streamIdleTimeoutMs)
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const streamTotalTimeoutMs = Number.isFinite(config.streamTotalTimeoutMs)
      && config.streamTotalTimeoutMs > 0
    ? Math.floor(config.streamTotalTimeoutMs)
    : provider === 'anthropic' ? DEFAULT_STREAM_TOTAL_TIMEOUT_MS : null;
  let globalCooldownUntil = 0;

  const continuity = {
    enabled: continuityMode,
    rateLimitFailovers,
    maxWaitMs: continuityMaxWaitMs,
    maxSleepMs: continuityMaxSleepMs,
    deferMs(milliseconds) {
      const delay = Math.min(Math.max(10, milliseconds), continuityMaxSleepMs);
      globalCooldownUntil = Math.max(globalCooldownUntil, Date.now() + delay);
    },
    async waitGlobal(signal, requestContext = null) {
      const cooldownRemaining = globalCooldownUntil - Date.now();
      if (cooldownRemaining <= 0) return true;
      const deadlineAt = requestContext == null ? null : startContinuityDeadline(requestContext);
      const deadlineRemaining = deadlineAt == null ? Infinity : deadlineAt - Date.now();
      if (deadlineRemaining <= 0) return false;
      const remaining = Math.min(cooldownRemaining, deadlineRemaining);
      if (remaining > 0) await sleepOrAbort(remaining, signal);
      if (remaining > 0 && !signal?.aborted && continuityJitterMs > 0) {
        const jitterRemaining = deadlineAt == null ? Infinity : deadlineAt - Date.now();
        if (jitterRemaining > 0) {
          await sleepOrAbort(
            Math.min(Math.floor(Math.random() * continuityJitterMs), jitterRemaining),
            signal,
          );
        }
      }
      return !signal?.aborted && (deadlineAt == null || Date.now() < deadlineAt);
    },
    async waitFor(seconds, signal, deadlineAt = null) {
      return this.waitForMs(seconds * 1000, signal, deadlineAt);
    },
    async waitForMs(milliseconds, signal, deadlineAt = null) {
      const deadlineRemaining = deadlineAt == null ? Infinity : deadlineAt - Date.now();
      if (deadlineRemaining <= 0) return false;
      const delay = Math.min(
        Math.max(10, milliseconds),
        continuityMaxSleepMs,
        deadlineRemaining,
      );
      await sleepOrAbort(delay, signal);
      return !signal?.aborted && (deadlineAt == null || Date.now() < deadlineAt);
    },
  };
  let requestCounter = 0;
  let inFlightProxied = 0; // proxied (non-status/oauth) requests currently being handled
  let bufferedRequestBytes = 0;
  let bufferedResponseBytes = 0;

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  // ── Active warm-up ─────────────────────────────────────────────────────────
  // Quota is only learned from real upstream rate-limit headers (Anthropic has no
  // "get my quota" endpoint), so a freshly (re)started proxy shows the whole fleet
  // as "—" until client traffic happens to flow through every account. Active
  // warm-up fixes that: it stages a request template from the first genuine
  // /v1/messages and COMMITS it only after upstream accepts that request (2xx) —
  // so a model/header combo upstream would reject can't seed a template that makes
  // every probe fail. The committed template (exact model + anthropic-version +
  // anthropic-beta + Claude-Code system) is replayed as a minimal probe
  // (max_tokens: 1) against each still-unmeasured account to populate its quota.
  // It fans out once the instant the template commits (right after the first
  // post-restart request) AND periodically (config.warmupIntervalMs, default 5m;
  // 0 = startup-only). Each probe is best-effort and side-effect-light: it never
  // refreshes tokens or mutates account status, reserves a real cap slot so it
  // can't push an account over maxConcurrent, and only learns from a 2xx (or an
  // account-level quota 429). `config.activeWarmup: false` disables it all.
  const activeWarmup = provider === 'anthropic' && config.activeWarmup !== false;
  const codexUsageRefresh = provider === 'codex' && config.codexUsageRefresh !== false;
  const warmupIntervalMs = Number.isFinite(config.warmupIntervalMs)
    ? Math.max(0, config.warmupIntervalMs)
    : 5 * 60 * 1000;
  // A structured organization-access 403 is authoritative for that moment,
  // but external billing/policy changes can restore the account later. Keep it
  // out of client rotation while periodically rechecking with the known-good
  // minimal probe shape. 0 disables only the automatic recheck; TUI R remains
  // an explicit recovery path.
  const subscriptionRecheckIntervalMs = Number.isFinite(config.subscriptionRecheckIntervalMs)
    ? Math.max(0, config.subscriptionRecheckIntervalMs)
    : 15 * 60 * 1000;
  // Active fast lane (codex): max age of an account's authoritative usage data
  // before a completed request on it triggers a background wham/usage re-fetch.
  // 0 disables the fast lane (periodic + startup refresh stay on).
  const codexUsageActiveMs = Number.isFinite(config.codexUsageActiveMs)
    ? Math.max(0, config.codexUsageActiveMs)
    : 60_000;
  // Reset credits (codex): automatic redemption policy. `enabled` gates only
  // the automatic triggers; the local operator endpoint always works in codex
  // mode. See src/codex-reset-credits.js + docs/specs/2026-09-05-codex-reset-credits.md.
  const resetCredits = normalizeCodexResetCreditsConfig(config, provider);
  // Auto-quarantine (codex): consecutive terminal (401/403) auth failures on
  // the wham/usage poll before the proxy escalates to a forced token refresh
  // plus a confirm re-poll. In-memory streak; the poll cadence is the pacing.
  const codexAuthFailureThreshold = Number.isFinite(config.codexAuthFailureThreshold)
    && config.codexAuthFailureThreshold >= 1
    ? Math.floor(config.codexAuthFailureThreshold)
    : 3;
  const WARMUP_PROBE_TIMEOUT_MS = 15_000;
  let probeTemplate = null;   // committed { model, version, beta, system } — only after a 2xx
  let warmupInFlight = false; // guard against overlapping fan-outs
  let codexRefreshPromise = null;
  let warmupClosed = false;   // set on server close: stop scheduling, abort in-flight probes
  const warmupAbort = new AbortController();

  // Stage a candidate template from a genuine /v1/messages request WITHOUT
  // committing — we only trust the shape once upstream has accepted it (see
  // commitProbeTemplate). Path-exact so /v1/messages/count_tokens isn't taken for
  // inference. Returns the candidate (or null). Called AFTER the response (the
  // caller decides whether a commit/upgrade is even possible), so the body
  // parse is only ever paid for the one or two requests that actually commit.
  function stageProbeTemplate(req, body) {
    if (!activeWarmup) return null;
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/v1/messages') return null;
    let json;
    try { json = JSON.parse(body.toString()); } catch { return null; }
    if (!json || typeof json.model !== 'string') return null;
    return {
      model: json.model,
      version: req.headers['anthropic-version'] || '2023-06-01',
      beta: req.headers['anthropic-beta'] || null,
      system: json.system ?? null,
    };
  }

  // Commit a staged template once its request succeeded (2xx), then fan out so
  // the rest of the fleet is measured within seconds of the first post-restart
  // request. The MODEL matters beyond acceptance: model-scoped weekly windows
  // (7d_oi — the "Fable" weekly limit) only appear on responses to requests for
  // that model tier, so probes replaying e.g. a haiku-shaped template can never
  // refresh the Fbl numbers. Therefore exactly one one-way UPGRADE is allowed:
  // a shape whose own response carried a 7d_* window (elicitsModelWeekly)
  // replaces a committed shape that didn't. No model names are hardcoded — the
  // template converges to whatever tier actually reports the extra window.
  function commitProbeTemplate(candidate, status, elicitsModelWeekly = false) {
    if (!activeWarmup || warmupClosed) return;
    if (!(status >= 200 && status < 300)) return; // only trust an accepted shape
    // A template RESTORED from the last run's snapshot is provisional: it let
    // probes work before any traffic, but upstream accepted it in a previous
    // process — the model may have been retired since. The first freshly
    // accepted shape therefore always replaces it (fresh evidence wins; the
    // Fable-window upgrade then re-applies organically among fresh commits).
    if (probeTemplate && !probeTemplate._restored
        && (probeTemplate._elicitsModelWeekly || !elicitsModelWeekly)) return;
    probeTemplate = { ...candidate, _elicitsModelWeekly: elicitsModelWeekly };
    setImmediate(() => {
      warmupUnmeasured();
      recheckSubscriptionDisabled();
    });
    // Note: the already-measured accounts still missing their Fable window are
    // healed by the periodic top-up pass (topUpModelWeekly) and by an on-demand
    // R — NOT here. Kicking a top-up off this commit would race a concurrent R's
    // refreshQuotaAll (both set `_warming`), skewing its M/N count for no real
    // gain, since the periodic pass fills the same windows within one interval.
  }

  function buildProbeBody(t) {
    const b = { model: t.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
    if (t.system != null) b.system = t.system; // mirror the real request (OAuth requires the system prompt)
    return JSON.stringify(b);
  }

  // A probe fetch is bounded by BOTH a timeout and server-close, so a scheduled or
  // in-flight probe can't keep sending a credentialed request after teardown.
  // Returns { signal, cleanup }: the caller MUST call cleanup() when the probe
  // settles (success OR failure) so a fast probe doesn't leave its 15s timer and
  // its warmupAbort listener dangling until the timeout fires.
  function probeSignal() {
    const ac = new AbortController();
    if (warmupAbort.signal.aborted) { ac.abort(); return { signal: ac.signal, cleanup() {} }; }
    const onClose = () => ac.abort();
    warmupAbort.signal.addEventListener('abort', onClose, { once: true });
    const t = setTimeout(() => ac.abort(), WARMUP_PROBE_TIMEOUT_MS);
    t.unref?.();
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(t);
      warmupAbort.signal.removeEventListener('abort', onClose);
    };
    return { signal: ac.signal, cleanup };
  }

  function codexUsageEndpoint() {
    const url = new URL(upstream);
    url.pathname = `${url.pathname.replace(/\/codex\/?$/, '').replace(/\/$/, '')}/wham/usage`;
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  async function refreshCodexAccount(account) {
    if (warmupClosed || !account.credential) return false;
    const outcome = await fetchCodexUsageOnce(account);
    await watchCodexAuthOutcome(account, outcome);
    const ok = outcome.applied;
    // Failure visibility without 60s-cadence spam: log once per failure STREAK
    // (first failure after a success), and once on recovery. A teardown abort
    // (warmupClosed) or a removed account is not a data-staleness signal.
    if (ok) {
      if (account._usageRefreshFailed) {
        account._usageRefreshFailed = false;
        console.log(`[TeamClaude] Codex usage refresh recovered for "${account.name}"`);
      }
    } else if (!warmupClosed
        && accountManager.accounts[account.index] === account
        && !account._usageRefreshFailed) {
      account._usageRefreshFailed = true;
      console.error(`[TeamClaude] Codex usage refresh failed for "${account.name}" — usage data stays stale until a refresh succeeds`);
    }
    return ok;
  }

  async function fetchCodexUsageOnce(account) {
    const probe = probeSignal();
    try {
      const headers = {
        accept: 'application/json',
        authorization: `Bearer ${account.credential}`,
      };
      if (account.accountId) headers['chatgpt-account-id'] = account.accountId;
      const res = await fetch(codexUsageEndpoint(), { headers, signal: probe.signal });
      if (!res.ok) {
        await res.body?.cancel();
        // 401/403 are credential verdicts from the backend — the only terminal
        // auth evidence a poll can carry. 5xx/429/anything else is transient
        // noise and (as before) never mutates account state.
        return {
          applied: false,
          authOk: false,
          terminalAuth: res.status === 401 || res.status === 403,
        };
      }
      const payload = await res.json();
      if (accountManager.accounts[account.index] !== account) {
        return { applied: false, authOk: false, terminalAuth: false };
      }
      const applied = accountManager.updateCodexUsage(account, payload);
      if (applied) {
        accountManager.markAccountSuccess(account);
        await accountManager.waitForAccountFlag(account).catch(err => {
          console.error(`[TeamClaude] Failed to persist subscription recovery for "${account.name}": ${err.message}`);
        });
      }
      return { applied, authOk: true, terminalAuth: false };
    } catch {
      // Network error / timeout / unparseable 2xx body: non-terminal.
      return { applied: false, authOk: false, terminalAuth: false };
    } finally {
      probe.cleanup();
    }
  }

  // Auto subscription-termination detection: usage polls double as credential
  // health checks. Only a streak of terminal (401/403) poll failures — never a
  // single one, and never 5xx/network noise — escalates, and even then the
  // account is parked only after a forced refresh + confirm re-poll agrees.
  // Accounts parked here are tagged `_errorFromUsagePoll`, which scopes the
  // automatic poll-success recovery in markAccountSuccess to THIS quarantine
  // (request-path 401 parks keep their stricter healing rules). Streaks are
  // in-memory only; a restart starts clean. Any positive auth evidence resets
  // the streak: a valid poll here, and a completed inference / applied poll via
  // markAccountSuccess — so an account that is actively serving traffic cannot
  // be quarantined by usage-endpoint-only 401/403s.
  async function watchCodexAuthOutcome(account, outcome) {
    if (warmupClosed || accountManager.accounts[account.index] !== account) return;
    if (outcome.authOk) {
      account._usageAuthStreak = 0;
      return;
    }
    if (!outcome.terminalAuth) return; // transient noise: streak neither grows nor resets
    if (account.status === 'error') return; // already parked — polls continue only for recovery
    const streak = (account._usageAuthStreak ?? 0) + 1;
    account._usageAuthStreak = streak;
    if (streak < codexAuthFailureThreshold) return;
    // Escalating consumes the streak: whatever the verdict below, the next
    // escalation needs a fresh streak (the poll interval is the pacing).
    account._usageAuthStreak = 0;
    await confirmCodexAuthFailure(account);
  }

  async function confirmCodexAuthFailure(account) {
    // Step 1: one forced token refresh. A terminal refresh failure (401 /
    // invalid_grant) parks the account inside ensureTokenFresh — including the
    // r7 delegation to subscription-ended when a declared cancellation is due.
    await accountManager.ensureTokenFresh(account, true)
      .catch(() => { /* terminal failures are handled inside ensureTokenFresh */ });
    if (warmupClosed || accountManager.accounts[account.index] !== account) return;
    if (account.status === 'error') {
      // Attribute the park precisely: during the awaited refresh the
      // request-path 401 handler may have parked this account itself
      // ('auth-revoked', `_errorFromRefresh` false). Only a refresh-caused
      // park (`_errorFromRefresh` true — set by ensureTokenFresh's terminal
      // failure, including the r7 subscription-ended delegation's
      // refresh-failed entry) belongs to THIS escalation; claiming a
      // request-path park would make it poll-healable, breaking the pinned
      // "request-path parks keep their stricter healing" contract.
      if (account._errorFromRefresh === true) account._errorFromUsagePoll = true;
      return;
    }
    // Step 2: re-poll once with the (possibly refreshed) credential. Terminal
    // again = a live token the backend still rejects → quarantine. A healthy
    // or inconclusive confirm leaves the account alone.
    const confirm = await fetchCodexUsageOnce(account);
    if (warmupClosed || accountManager.accounts[account.index] !== account) return;
    if (confirm.authOk || !confirm.terminalAuth) return;
    // Parked by another path while the re-poll was in flight: that park keeps
    // its own healing rules — never re-mark or re-tag it here.
    if (account.status === 'error') return;
    // Circuit breaker: poll-only evidence must never park the LAST available
    // account. If the whole fleet is truly dead, real request traffic (or a
    // terminal token refresh) still parks the final account on request-path
    // evidence; a usage-endpoint-only outage must not empty an idle pool.
    // The streak stays consumed — the next threshold re-judges availability.
    if (!accountManager.hasOtherAvailableAccount(account)) {
      console.error(`[TeamClaude] Codex account "${account.name}" failed the usage-poll auth confirmation, but it is the last available account — quarantine deferred (re-judged on the next failure streak)`);
      return;
    }
    accountManager.markAuthenticationError(account, 'auth-revoked');
    // Tag synchronously with the park (no await in between): a concurrent
    // request-path park can never be mistaken for this one.
    if (account.status === 'error') account._errorFromUsagePoll = true;
    console.error(`[TeamClaude] Codex account "${account.name}" quarantined: usage polls and a fresh token both rejected (auto-recovers on a valid usage poll)`);
    await accountManager.waitForAccountFlag(account).catch(err => {
      console.error(`[TeamClaude] Failed to persist subscription metadata for "${account.name}": ${err.message}`);
    });
  }

  async function refreshCodexQuotaAll() {
    if (!codexUsageRefresh || warmupClosed) return -1;
    if (codexRefreshPromise) return codexRefreshPromise;
    codexRefreshPromise = (async () => {
      while (!warmupClosed) {
        const targets = accountManager.accounts.filter(a => a.provider === 'codex' && a.credential);
        const outcomes = await Promise.all(targets.map(refreshCodexAccount));
        const current = accountManager.accounts.filter(a => a.provider === 'codex' && a.credential);
        if (targets.length === current.length && targets.every((account, i) => account === current[i])) {
          return {
            targets: targets.length,
            measured: outcomes.filter(Boolean).length,
          };
        }
      }
      return -1;
    })();
    try {
      return await codexRefreshPromise;
    } finally {
      codexRefreshPromise = null;
    }
  }

  // Active fast lane: called from the request-completion path (the finally that
  // releases the concurrency slot — runs for SSE and non-SSE alike) with the
  // account that served the request. When that account's authoritative usage
  // stamp (quota.codexUsageAt — set only by the wham/usage apply, never by
  // per-response headers) is older than codexUsageActiveMs, kick a background
  // refreshCodexAccount. Fire-and-forget: it must never block, delay, or fail
  // the response path, and _usageRefreshing keeps it single-flight per account
  // (a failed attempt doesn't stamp freshness, so the next completed request
  // simply retries).
  function maybeRefreshCodexUsage(account) {
    if (!codexUsageRefresh || warmupClosed || codexUsageActiveMs <= 0) return;
    if (!account || account.provider !== 'codex' || account._usageRefreshing) return;
    if (accountManager.accounts[account.index] !== account) return;
    if (Date.now() - (account.quota?.codexUsageAt ?? 0) < codexUsageActiveMs) return;
    account._usageRefreshing = true;
    Promise.resolve()
      .then(() => refreshCodexAccount(account))
      .catch(() => { /* refreshCodexAccount is already best-effort */ })
      .finally(() => { account._usageRefreshing = false; });
  }

  // Codex reset credits. One redemption attempt per account at a time; the
  // outcome is folded into the account at once (a "reset" makes it routable
  // again immediately) and an authoritative wham/usage refresh follows shortly
  // after so the meter reflects the backend's view. Best-effort throughout —
  // a failure here never breaks the request path, it just falls through to the
  // existing exhaustion handling.
  const RESET_CREDIT_REFRESH_DELAY_MS = 1500;
  const RESET_CREDIT_NO_CANDIDATE_LOG_MS = 60_000;
  let resetCreditNoCandidateLoggedAt = 0;
  const NO_RESET = Object.freeze({ reset: false, kind: 'no-spend', outcome: null });

  function resetCreditEligibilityOptions(model = null) {
    return {
      reserve: resetCredits.reserve,
      cooldownMs: resetCredits.cooldownMs,
      isExhausted: candidate => accountManager.isExhausted(candidate),
      // A reset on an account quarantined for the requested model restores
      // quota nobody can use for this request.
      canServe: candidate => !accountManager._isModelUnsupported(candidate, model),
    };
  }

  function scheduleResetCreditUsageRefresh(account) {
    if (!codexUsageRefresh || warmupClosed) return;
    const timer = setTimeout(() => {
      if (warmupClosed || accountManager.accounts[account.index] !== account) return;
      refreshCodexAccount(account).catch(() => { /* best-effort */ });
    }, RESET_CREDIT_REFRESH_DELAY_MS);
    timer.unref?.();
  }

  // One redemption attempt on one account. Returns { reset, kind, outcome }:
  // `reset` = routable again; `kind` classifies the attempt for the fleet walk
  // (see codexResetCreditOutcomeKind). `enforceEligibility` applies the
  // automatic-policy guards (credits known/reserve/cooldown/exhausted/can
  // serve); the operator endpoint passes false. Single-flight per account.
  async function redeemCodexResetCredit(account, reason, { enforceEligibility = true, model = null } = {}) {
    if (provider !== 'codex' || !account || account.provider !== 'codex') return NO_RESET;
    if (enforceEligibility) {
      const verdict = codexResetCreditEligibility(account, resetCreditEligibilityOptions(model));
      if (!verdict.eligible) return NO_RESET;
    }
    if (account._resetCreditPromise) return account._resetCreditPromise;
    account._resetCreditPromise = (async () => {
      try {
        // ensureTokenFresh never throws — a failed refresh only logs and may
        // park the account — so judge the result, not an exception.
        await accountManager.ensureTokenFresh(account);
        if (accountManager.accounts[account.index] !== account) return NO_RESET;
        if (!account.credential || account.status === 'error' || account.authRevoked === true
            || isTokenExpiringSoon(account.expiresAt)) {
          const outcome = { ok: false, code: 'token_refresh_failed', windowsReset: null, status: null, error: null };
          applyCodexResetCreditOutcome(account, outcome);
          console.error(`[TeamCodex] Reset credit on "${account.name}" (${reason}) skipped — credential unusable (status ${account.status})`);
          return { reset: false, kind: 'no-spend', outcome };
        }
        const outcome = await consumeCodexResetCredit({
          account,
          upstream,
          timeoutMs: resetCredits.timeoutMs,
        });
        const reset = applyCodexResetCreditOutcome(account, outcome);
        const kind = codexResetCreditOutcomeKind(outcome);
        if (reset) {
          console.log(`[TeamCodex] Reset credit redeemed on "${account.name}" (${reason}): windows_reset=${outcome.windowsReset ?? '?'}, credits left=${account.quota.codexResetCredits ?? '?'}`);
        } else if (kind === 'spent-no-reset') {
          console.error(`[TeamCodex] Reset credit SPENT on "${account.name}" (${reason}) but the backend reset no windows (windows_reset=0); credits left=${account.quota.codexResetCredits ?? '?'}`);
        } else if (kind === 'indeterminate') {
          console.error(`[TeamCodex] Reset credit on "${account.name}" (${reason}) indeterminate: ${outcome.code}${outcome.error ? ` — ${outcome.error}` : ''}; refreshing usage, not trying other accounts this pass`);
        } else {
          console.log(`[TeamCodex] Reset credit NOT applied on "${account.name}" (${reason}): ${outcome.code}${outcome.error ? ` — ${outcome.error}` : ''}`);
        }
        // Re-read the authoritative meter after ANY attempt: a reset must be
        // confirmed, and an indeterminate/unexpected answer may have changed
        // the backend state without telling us.
        scheduleResetCreditUsageRefresh(account);
        return { reset, kind, outcome };
      } finally {
        account._resetCreditPromise = null;
      }
    })();
    return account._resetCreditPromise;
  }

  // Fleet-level automatic redemption: walk the eligible exhausted accounts
  // (most credits first). Stops at the first reset, and ALSO after any
  // attempt that may have spent a credit (spent-no-reset / indeterminate) —
  // moving on to the next account after those is the double-spend path.
  // Returns true when at least one account is routable again.
  // Returns { redeemed, chargePass }: `chargePass` is true when at least one
  // attempt may have spent a credit (reset / spent-no-reset / indeterminate),
  // so the caller charges the request's single pass only for spend-capable
  // work — a walk with no eligible candidate leaves the pass unspent.
  async function redeemCodexResetCreditForFleet(accounts, reason, model = null, resolved = null) {
    const nothing = { redeemed: false, chargePass: false };
    if (!resetCredits.enabled || warmupClosed) return nothing;
    // "Has the dead end been resolved by someone else?" — judged with the
    // CALLER's request scope (credential-type exclusions etc.), never with a
    // pool-wide view that could see an account this request cannot use.
    const deadEndResolved = typeof resolved === 'function'
      ? resolved
      : () => accountManager.anyUsable(null, model) || accountManager.anyCapped(null, model);
    const options = resetCreditEligibilityOptions(model);
    const candidates = rankCodexResetCreditCandidates(accounts, options);
    if (candidates.length === 0) {
      const now = Date.now();
      if (now - resetCreditNoCandidateLoggedAt >= RESET_CREDIT_NO_CANDIDATE_LOG_MS) {
        resetCreditNoCandidateLoggedAt = now;
        console.log(`[TeamCodex] Reset credit: no eligible account at the quota dead end (${describeCodexResetCreditCandidates(accounts, options).join(', ') || 'no codex accounts'})`);
      }
      return nothing;
    }
    // A walk that never reached the backend (every candidate re-judged as
    // ineligible) leaves the pass unspent; one that made ANY real attempt —
    // even a definite no-spend answer — charges it, so a request cannot
    // re-POST consume on every wait-loop iteration (cooldown 0 has no other
    // brake). The local NO_RESET sentinel is the "no attempt" marker.
    let attempted = false;
    for (const candidate of candidates) {
      // Re-judge right before acting: another request or the operator
      // endpoint may have redeemed (or exhausted the credits of) this
      // candidate while an earlier candidate's consume was in flight.
      const result = await redeemCodexResetCredit(candidate, reason, { enforceEligibility: true, model });
      if (result !== NO_RESET) attempted = true;
      if (result.reset) return { redeemed: true, chargePass: true };
      if (result.kind !== 'no-spend') return { redeemed: false, chargePass: true };
      // The dead end may have been resolved by someone else (operator reset,
      // another request's pass, a window rollover) while this attempt was in
      // flight: yield to the routable account instead of spending on the next.
      if (deadEndResolved()) return { redeemed: true, chargePass: attempted };
    }
    return { redeemed: false, chargePass: attempted };
  }

  // Handed to forwardRequest through ctx: null when automatic redemption is
  // off, so the request path stays byte-identical to the pre-feature behavior.
  const resetCreditController = resetCredits.enabled
    ? {
        policy: resetCredits.policy,
        fleet: redeemCodexResetCreditForFleet,
        // Returns the full { reset, kind } so the 429 branch can charge the
        // request's single pass for ANY outcome that may have spent a credit.
        account: (account, reason, model = null) =>
          redeemCodexResetCredit(account, reason, { enforceEligibility: true, model }),
      }
    : null;

  // Probe one account: send a minimal /v1/messages with its own auth and fold the
  // rate-limit headers into its quota. Best-effort and side-effect-light:
  //  - Never refreshes tokens — a background refresh failure could mark the account
  //    'error' and pull it from rotation before any real request proved auth. An
  //    OAuth account with an expiring token is left to the client path (which has
  //    the proper 401 → forced-refresh → error handling).
  //  - Does NOT reserve a client concurrency slot. The hard rule is "client traffic
  //    must not break". A probe that shared the per-account cap would inevitably
  //    subtract one client slot, which — with the overflow queue disabled — lets
  //    the proxy itself 429 a client when every slot is momentarily taken (no
  //    account to fail over to). So the cap is left entirely to clients; a probe is
  //    at most ONE extra concurrent request, and only ever on an idle, non-sticky,
  //    unmeasured account (warmupCandidates requires inflight===0; real traffic
  //    concentrates on the *measured* sticky account, not here). maxConcurrent is a
  //    conservative soft cap kept under Anthropic's real per-account limit (see
  //    CLAUDE.md, "the cap is not a hard binding"), so that transient +1 stays
  //    safe — and in the unlikely event it did cause a client rate-429, the
  //    existing 429 failover transparently recovers it, whereas a probe-induced
  //    capacity 429 could not.
  //  - Learns ONLY from a response upstream accepted (2xx) or an account-level
  //    quota 429 ('rejected') — a 4xx / non-exhaustion 429 / 5xx never mutates state.
  async function warmupAccount(account, { force = false } = {}) {
    if (!probeTemplate || warmupClosed || account._warming) return;
    // Don't refresh from a background probe; skip an OAuth account that needs one.
    if (account.type === 'oauth' && isTokenExpiringSoon(account.expiresAt)) return;
    // Re-confirm it's still an available, unmeasured, idle candidate — unless
    // this is a FORCED re-measure (TUI Reload), which deliberately probes
    // already-measured (and even throttled/near-quota) accounts to pull fresh
    // upstream numbers. The idle/enabled screening for that path lives in
    // refreshQuotaAll.
    if (!force && !accountManager.warmupCandidates().includes(account)) return;
    account._warming = true;
    const probe = probeSignal();
    try {
      const headers = { 'content-type': 'application/json', 'anthropic-version': probeTemplate.version };
      if (probeTemplate.beta) headers['anthropic-beta'] = probeTemplate.beta;
      if (account.type === 'oauth') headers['authorization'] = `Bearer ${account.credential}`;
      else headers['x-api-key'] = account.credential;

      const res = await fetch(`${upstream}/v1/messages`, {
        method: 'POST', headers, body: buildProbeBody(probeTemplate), signal: probe.signal,
      });
      // A completed 2xx is authoritative proof that this organization can use
      // Claude Code again. Clear the durable quarantine before folding quota so
      // the account immediately returns to selection and the config flag is
      // removed through onAccountFlag.
      if (res.ok && account.subscriptionDisabled
          && accountManager.accounts[account.index] === account) {
        console.log(`[TeamClaude] Subscription access recheck succeeded for "${account.name}" — returning account to rotation`);
        accountManager.setSubscriptionDisabled(account, false);
        delete account._subscriptionRecheckAt;
      }
      const rl = {};
      for (const [k, v] of res.headers.entries()) {
        if (k.startsWith('anthropic-ratelimit-')) rl[k] = v;
      }
      await res.body?.cancel();
      // Learn ONLY from a response upstream accepted (2xx) or an *account-level*
      // quota 429 — one whose `unified-status` is `rejected` (the account is
      // genuinely over its limit). A non-exhaustion 429 (request-rate / global /
      // transient) carries rate-limit headers too but is NOT account state;
      // folding it in would wrongly mark the account measured/unavailable and
      // break best-effort. updateQuota by OBJECT is reindex-safe; still skip a
      // detached (removed-mid-fetch) account.
      const accountExhausted429 = res.status === 429
        && rl['anthropic-ratelimit-unified-status'] === 'rejected';
      if ((res.ok || accountExhausted429) && Object.keys(rl).length
          && accountManager.accounts[account.index] === account) {
        accountManager.updateQuota(account, rl);
        // Convergence accounting: a probe that leaves the account fully
        // measured resets the fruitless-probe counter; one that leaves it
        // half-measured (a header family missing) counts toward the cap.
        if (accountManager._fullyMeasured(account)) {
          account._partialProbes = 0;
        } else {
          account._partialProbes = (account._partialProbes || 0) + 1;
          account._lastFruitlessProbeAt = Date.now(); // paces the slow retry backstop
        }
        // Model-weekly (Fable) top-up accounting: if this probe's response
        // carried the window, clear the top-up budget; if it did NOT (this
        // account/tier just doesn't report it) count toward the cap so the
        // top-up pass below doesn't probe it forever.
        if (Object.keys(account.quota.modelWeekly).length > 0) account._mwProbes = 0;
        else account._mwProbes = (account._mwProbes || 0) + 1;
        console.log(`[TeamClaude] Warm-up measured account "${account.name}"`);
        return true; // quota actually folded — the forced-refresh path counts these
      } else if (accountManager.accounts[account.index] === account
          && (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429))) {
        // The probe COMPLETED with a DETERMINISTIC fruitless outcome — a 2xx
        // with no rate-limit headers (contract violation that will repeat), or
        // a 4xx (bad shape / revoked auth — same next time). Count it toward
        // the convergence cap so such an upstream/account is not probed every
        // interval forever. Transient trouble — 5xx, a non-exhaustion 429, or
        // a network failure (the catch below) — is deliberately NOT counted: a
        // fully unmeasured account has no reset timestamp, so no sweep would
        // ever clear its counter, and counting a passing blip would abandon it
        // permanently even after upstream recovers.
        account._partialProbes = (account._partialProbes || 0) + 1;
        account._lastFruitlessProbeAt = Date.now(); // paces the slow retry backstop
      }
    } catch (err) {
      // Best-effort: leave the account unmeasured (exactly as before warm-up).
      console.error(`[TeamClaude] Warm-up probe failed for "${account.name}": ${err.message}`);
    } finally {
      probe.cleanup(); // clear the timeout + warmupAbort listener now (not 15s later)
      account._warming = false;
    }
    return false; // skipped, fruitless, or failed — nothing was measured
  }

  // Forced fleet re-measure (TUI Reload / R): probe EVERY idle account —
  // measured or not, ENABLED OR DISABLED — so the dashboard reflects fresh
  // upstream numbers on demand. Usage spent from other devices/sessions never
  // flows through this proxy, so the displayed values can silently drift until
  // the next organic measurement. Disabled accounts are out of *rotation*, not
  // out of *monitoring*: R is an explicit "show me everything" action, and a
  // probe is read-only (it reserves no rotation slot and routes no client
  // traffic), so refreshing a disabled account's dashboard row is safe and is
  // what the user expects. Throttled/near-quota accounts are included on purpose
  // (their exhausted-429 responses still carry authoritative quota headers);
  // only accounts with a request in flight are skipped (that response refreshes
  // them anyway). The convergence budgets are renewed first — an explicit user
  // action is a fresh reason to probe. Returns { targets, measured }, or -1 when
  // no probe template exists yet (nothing has flowed through the proxy, so there
  // is no known-accepted request shape to replay).
  async function refreshQuotaAll() {
    if (provider === 'codex') return refreshCodexQuotaAll();
    if (!activeWarmup || warmupClosed || !probeTemplate) return -1;
    const targets = accountManager.accounts.filter(a =>
      (a.status !== 'error' || a.errorReason === 'subscription-disabled')
      && a.inflight === 0 && !a._warming);
    // Revive lapsed tokens FIRST. Background probes never refresh tokens (a
    // background failure could mark an account 'error' before any real request
    // proved auth), so an account that has sat idle past its token lifetime
    // gets silently skipped by warmupAccount's expiring-token guard — the
    // no.1 reason a fleet-wide refresh would quietly update almost nothing.
    // An explicit user action (R) is the right moment to pay that refresh:
    // failures are the same actionable truth the client path would surface.
    await Promise.all(targets.map(a =>
      accountManager.ensureTokenFresh(a).catch(() => { /* surfaces via status/error below */ })));
    const alive = targets.filter(a =>
      a.status !== 'error' || a.errorReason === 'subscription-disabled');
    // Renew both probe budgets — R is an explicit "measure everything now".
    for (const a of alive) { a._partialProbes = 0; a._mwProbes = 0; }
    const outcomes = await Promise.all(alive.map(a => warmupAccount(a, { force: true })));
    // Honest accounting: `targets` is what the user asked to refresh, `measured`
    // is what actually got fresh data — the TUI reports M/N, never a blanket
    // "refreshed N" while probes silently skipped or failed.
    return { targets: targets.length, measured: outcomes.filter(Boolean).length };
  }

  // Model-weekly (Fable) top-up: an account fully measured for 5h/7d but missing
  // its 7d_oi window (measured by lower-tier traffic/probe) is NOT an ordinary
  // warm-up candidate, so nothing re-probes it — its `Fbl` bar stays blank
  // indefinitely. Once the committed template is known to elicit the window,
  // re-probe such accounts (bounded by _mwProbes) so the Fable numbers self-heal
  // within a warm-up interval instead of waiting for the user to press R while
  // that exact account is idle. Force-probes so the fully-measured guard doesn't
  // exclude them; still skips in-flight/disabled/error accounts.
  async function topUpModelWeekly() {
    if (!activeWarmup || warmupClosed || !probeTemplate || !probeTemplate._elicitsModelWeekly) return;
    const targets = accountManager.accounts.filter(a =>
      a.enabled !== false && a.status !== 'error' && a.inflight === 0 && !a._warming
      && accountManager.needsModelWeekly(a));
    if (!targets.length) return;
    await Promise.all(targets.map(a => warmupAccount(a, { force: true })));
  }

  // Partial-quota top-up: after a restart the lazy sweep clears an expired
  // session (5h) window while a still-future weekly (7d) window survives, so an
  // account is measured for one window only. `_isMeasured` (any-data) is already
  // true, so warmupUnmeasured skips it; it isn't fully measured, so
  // needsModelWeekly skips it too — and if the surviving weekly window is
  // exhausted, no real traffic reaches it. Its session/Fable numbers stay a
  // permanent blank. Re-probe such accounts (bounded by _partialProbes) so one
  // response repopulates both windows. Force-probes so the near-quota guard
  // doesn't exclude an exhausted account (its exhausted-429 still carries
  // authoritative 5h/7d headers); still skips in-flight/disabled/error accounts.
  // Unlike topUpModelWeekly this needs no window-eliciting template — any
  // accepted probe shape repopulates the unified windows.
  async function topUpPartialQuota() {
    if (!activeWarmup || warmupClosed || !probeTemplate) return;
    const targets = accountManager.accounts.filter(a =>
      a.enabled !== false && a.status !== 'error' && a.inflight === 0 && !a._warming
      && accountManager.needsPartialRemeasure(a));
    if (!targets.length) return;
    // Revive lapsed tokens FIRST (same rationale as refreshQuotaAll): a partial
    // account is typically weekly-exhausted → out of rotation → zero client
    // traffic → its OAuth token lapses past the 8h lifetime, and warmupAccount
    // deliberately skips expiring-token accounts (background probes never
    // refresh). Without this step the re-probe silently never happens and the
    // session/Fable blanks persist (measured 2026-07-22: 6 accounts stuck).
    // A refresh failure marks the account 'error', which drops it from future
    // targets — no retry loop; a success is one refresh per ~8h, negligible.
    await Promise.all(targets.map(a =>
      accountManager.ensureTokenFresh(a).catch(() => { /* surfaces via status */ })));
    const alive = targets.filter(a => a.status !== 'error');
    if (!alive.length) return;
    await Promise.all(alive.map(a => warmupAccount(a, { force: true })));
  }

  // Revalidate only the narrowly classified organization-access quarantine.
  // Other auth errors stay parked until re-import/login because a generic
  // probe must never revive revoked credentials. Each account is paced before
  // dispatch so overlapping timer/template triggers cannot duplicate probes.
  async function recheckSubscriptionDisabled() {
    if (!activeWarmup || warmupClosed || !probeTemplate
        || subscriptionRecheckIntervalMs <= 0) return;
    const now = Date.now();
    const targets = accountManager.accounts.filter(a =>
      a.enabled !== false && a.subscriptionDisabled === true
      && a.errorReason === 'subscription-disabled'
      && a.inflight === 0 && !a._warming
      && (!a._subscriptionRecheckAt || now >= a._subscriptionRecheckAt));
    if (!targets.length) return;
    for (const account of targets) {
      account._subscriptionRecheckAt = now + subscriptionRecheckIntervalMs;
    }
    await Promise.all(targets.map(async account => {
      await accountManager.ensureTokenFresh(account)
        .catch(() => { /* keep quarantined; the next interval retries */ });
      if (account.errorReason !== 'subscription-disabled') return false;
      return warmupAccount(account, { force: true });
    }));
  }

  // Probe every currently-unmeasured idle account in parallel. Guarded so two
  // triggers (first-commit + the interval) can't run overlapping fan-outs.
  async function warmupUnmeasured() {
    if (!activeWarmup || warmupClosed || !probeTemplate || warmupInFlight) return;
    warmupInFlight = true;
    try {
      await Promise.all(accountManager.warmupCandidates().map(a => warmupAccount(a)));
    } finally {
      warmupInFlight = false;
    }
  }

  // Periodic warm-up: re-measures any account that is still unmeasured — including
  // one whose quota window just reset (its utilization is cleared, so the
  // dashboard reads "—" again) — without waiting for client traffic to reach it.
  let warmupTimer = null;
  if (activeWarmup && warmupIntervalMs > 0) {
    warmupTimer = setInterval(() => {
      // Sweep expired quota windows first: a rolled-over window keeps its
      // account "measured" (with stale values) until some request-path sweep
      // runs, and warm-up only probes UNMEASURED accounts — so without this an
      // idle proxy would never re-measure after a reset. Sweep → unmeasured →
      // the fan-out below re-probes → fresh data → ordering/display update.
      accountManager.sweepExpired();
      warmupUnmeasured();
      topUpPartialQuota(); // heal half-measured accounts (a window swept, the other survives)
      topUpModelWeekly(); // heal fully-measured accounts still missing their Fable window
    }, warmupIntervalMs);
    warmupTimer.unref(); // never keep the process alive just for warm-up
  }
  // Subscription recovery has its OWN scheduler. It must not inherit
  // `warmupIntervalMs: 0` (quota startup-only mode), or a later organization
  // access 403 would be parked forever even though automatic rechecks remain
  // enabled. Tick at least once a minute; `_subscriptionRecheckAt` above keeps
  // the configured per-account interval authoritative and prevents early probes.
  let subscriptionRecheckTimer = null;
  if (activeWarmup && subscriptionRecheckIntervalMs > 0) {
    const tickMs = Math.min(subscriptionRecheckIntervalMs, 60_000);
    subscriptionRecheckTimer = setInterval(() => {
      recheckSubscriptionDisabled();
    }, tickMs);
    subscriptionRecheckTimer.unref();
  }
  let codexUsageTimer = null;
  if (codexUsageRefresh) {
    setImmediate(() => { refreshCodexQuotaAll(); });
    if (warmupIntervalMs > 0) {
      codexUsageTimer = setInterval(() => { refreshCodexQuotaAll(); }, warmupIntervalMs);
      codexUsageTimer.unref();
    }
  }

  function rejectEarlyRequest(req, res, statusCode, headers, payload) {
    req.pause();
    res.shouldKeepAlive = false;
    res.once('finish', () => req.destroy());
    res.writeHead(statusCode, { ...headers, connection: 'close' });
    res.end(JSON.stringify(payload));
  }

  function startRequestBodyDeadline(req, res) {
    let timedOut = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      req.off('end', cleanup);
      req.off('aborted', cleanup);
      req.off('error', cleanup);
    };
    const onTimeout = () => {
      timedOut = true;
      cleanup();
      if (!res.headersSent && !res.destroyed) {
        rejectEarlyRequest(req, res, 408, { 'Content-Type': 'application/json' }, {
          type: 'error',
          error: { type: 'invalid_request_error', message: 'Request body timed out' },
        });
      } else if (!req.destroyed) {
        req.destroy();
      }
    };
    req.once('end', cleanup);
    req.once('aborted', cleanup);
    req.once('error', cleanup);
    timer = setTimeout(onTimeout, requestBodyTimeoutMs);
    timer.unref();
    return { cleanup, didTimeout: () => timedOut };
  }

  const server = http.createServer(async (req, res) => {
    let bodyDeadline = null;
    try {
      // Auth check — skip for localhost connections
      const clientKey = req.headers['x-api-key'];
      const authorization = req.headers.authorization;
      const hasRecoveryMarker = provider === 'anthropic'
        && hasClaudeRecoveryMarker(authorization);
      const recoveryAccountUuid = provider === 'anthropic'
        ? parseClaudeRecoveryAccount(authorization)
        : null;
      const bearerKey = typeof authorization === 'string' && authorization.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length)
        : null;
      const remoteAddr = req.socket.remoteAddress;
      const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      const isRotateRequest = req.url === '/teamclaude/rotate';
      // Operator trigger for a Codex reset credit. Same trust boundary as
      // rotation: loopback only, proxy API key when one is configured, body-free.
      const isResetCreditRequest = provider === 'codex'
        && req.url.split('?', 1)[0] === '/teamclaude/codex/reset-credit';
      if (hasRecoveryMarker && recoveryAccountUuid == null) {
        rejectEarlyRequest(req, res, 403, { 'Content-Type': 'application/json' }, {
          type: 'error',
          error: { type: 'permission_error', message: 'Invalid Claude recovery routing marker.' },
        });
        return;
      }
      if (hasRecoveryMarker && !isLocal) {
        rejectEarlyRequest(req, res, 403, { 'Content-Type': 'application/json' }, {
          type: 'error',
          error: { type: 'permission_error', message: 'Claude recovery routing is local-only.' },
        });
        return;
      }
      if (isRotateRequest && !isLocal) {
        rejectEarlyRequest(req, res, 403, { 'Content-Type': 'application/json' }, {
          type: 'error',
          error: { type: 'permission_error', message: 'Account rotation is local-only.' },
        });
        return;
      }
      if (isResetCreditRequest && !isLocal) {
        rejectEarlyRequest(req, res, 403, { 'Content-Type': 'application/json' }, {
          type: 'error',
          error: { type: 'permission_error', message: 'Reset credit redemption is local-only.' },
        });
        return;
      }
      if ((isRotateRequest || isResetCreditRequest) && proxyApiKey
          && clientKey !== proxyApiKey && bearerKey !== proxyApiKey) {
        rejectEarlyRequest(req, res, 401, { 'Content-Type': 'application/json' }, {
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid proxy API key' },
        });
        return;
      }
      if (proxyApiKey && clientKey !== proxyApiKey && bearerKey !== proxyApiKey && !isLocal) {
        rejectEarlyRequest(req, res, 401, { 'Content-Type': 'application/json' }, {
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid proxy API key' },
        });
        return;
      }

      if (isRotateRequest) {
        if (req.method !== 'POST') {
          rejectEarlyRequest(
            req,
            res,
            405,
            { 'Content-Type': 'application/json', Allow: 'POST' },
            {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'Account rotation requires POST.' },
            },
          );
          return;
        }
        const contentLength = req.headers['content-length'];
        const bodyFree = (contentLength == null || contentLength === '0')
          && req.headers['transfer-encoding'] == null;
        if (!bodyFree) {
          rejectEarlyRequest(req, res, 400, { 'Content-Type': 'application/json' }, {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Account rotation does not accept a body.' },
          });
          return;
        }
        const result = accountManager.rotateActiveAccount(null, true, recoveryAccountUuid);
        if (!result.rotated) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: {
              type: 'no_alternative_account',
              message: 'No alternate account is available.',
            },
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (isResetCreditRequest) {
        if (req.method !== 'POST') {
          rejectEarlyRequest(
            req,
            res,
            405,
            { 'Content-Type': 'application/json', Allow: 'POST' },
            {
              type: 'error',
              error: { type: 'invalid_request_error', message: 'Reset credit redemption requires POST.' },
            },
          );
          return;
        }
        const contentLength = req.headers['content-length'];
        const bodyFree = (contentLength == null || contentLength === '0')
          && req.headers['transfer-encoding'] == null;
        if (!bodyFree) {
          rejectEarlyRequest(req, res, 400, { 'Content-Type': 'application/json' }, {
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Reset credit redemption does not accept a body; pass ?account=<name>.' },
          });
          return;
        }
        const requestedName = new URL(req.url, 'http://localhost').searchParams.get('account');
        const target = typeof requestedName === 'string' && requestedName.length > 0
          ? accountManager.accounts.find(candidate => candidate.provider === 'codex' && candidate.name === requestedName)
          : null;
        if (!target) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'not_found_error', message: 'Unknown Codex account; pass ?account=<name>.' },
          }));
          return;
        }
        // Explicit operator intent bypasses the automatic policy/eligibility
        // (cooldown, reserve, exhaustion) but keeps the single-flight guard.
        const { reset } = await redeemCodexResetCredit(target, 'operator', { enforceEligibility: false });
        const quota = target.quota || {};
        res.writeHead(reset ? 200 : 409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          account: target.name,
          reset,
          outcome: quota.codexResetCreditLastOutcome ?? null,
          resetCredits: quota.codexResetCredits ?? null,
          unified5h: quota.unified5h ?? null,
          unified7d: quota.unified7d ?? null,
        }));
        return;
      }

      const isStatusRequest = req.method === 'GET' && req.url === '/teamclaude/status';
      const contentLength = req.headers['content-length'];
      const bodyFreeStatus = isStatusRequest
        && (contentLength == null || contentLength === '0')
        && req.headers['transfer-encoding'] == null;

      if (bodyFreeStatus) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        // `host` rides along so `teamcodex status` (a separate process) can show
        // the machine the PROXY runs on — CPU% is measured between status calls
        // by the tracker, RAM/loadavg are instantaneous.
        const includeIdentity = isLocal
          && Boolean(proxyApiKey)
          && clientKey === proxyApiKey
          && req.headers['x-teamcodex-status-identity'] === '1';
        res.end(JSON.stringify({
          ...accountManager.getStatus({ includeIdentity }),
          host: hostTracker.sample(),
          ...(provider === 'codex'
            ? {
                resetCredits: {
                  enabled: resetCredits.enabled,
                  policy: resetCredits.policy,
                  cooldownMs: resetCredits.cooldownMs,
                  reserve: resetCredits.reserve,
                },
              }
            : {}),
          ...(includeIdentity ? { lifecycleId: config.lifecycleId || null } : {}),
        }, null, 2));
        return;
      }

      // Everything below buffers a request body (the OAuth relay AND the proxied
      // path) → request count stays within fleet/queue capacity before buffering.
      // Each process reserves its local body copy; the supervisor separately
      // accounts for public-path copies before forwarding to a worker.
      const admissionCapacity = accountManager.totalCapacity();
      if (inFlightProxied >= admissionCapacity) {
        rejectEarlyRequest(
          req,
          res,
          429,
          { 'Content-Type': 'application/json', 'retry-after': '5' },
          {
            type: 'error',
            error: { type: 'rate_limit_error', message: 'Proxy at capacity; retry shortly.' },
          },
        );
        return;
      }
      inFlightProxied++;
      let requestBufferedBytes = 0;
      let responseBufferedBytes = 0;
      let auxiliaryResponseBytes = 0;
      let logResponseBytes = 0;
      let responseReleased = false;
      let releaseIdleLogReservation = null;
      const reserveRequestBytes = bytes => {
        if (bytes <= 0) return true;
        if (bytes > maxBufferedRequestBytes - bufferedRequestBytes) return false;
        bufferedRequestBytes += bytes;
        requestBufferedBytes += bytes;
        return true;
      };
      const releaseRequestBytes = bytes => {
        if (bytes <= 0) return;
        if (bytes > requestBufferedBytes || bytes > bufferedRequestBytes) {
          throw new Error('Request buffer reservation underflow');
        }
        bufferedRequestBytes -= bytes;
        requestBufferedBytes -= bytes;
      };
      const reserveResponseBytes = bytes => {
        if (bytes <= 0) return true;
        if (responseReleased) return false;
        if (bytes > maxBufferedResponseBytes - bufferedResponseBytes) {
          releaseIdleLogReservation?.();
        }
        if (bytes > maxBufferedResponseBytes - bufferedResponseBytes) return false;
        bufferedResponseBytes += bytes;
        responseBufferedBytes += bytes;
        return true;
      };
      const releaseResponseBytes = () => {
        if (responseReleased) return;
        releaseReservedResponseBytes(responseBufferedBytes);
        responseReleased = true;
      };
      const releaseReservedResponseBytes = bytes => {
        if (bytes <= 0) return;
        if (responseReleased) return;
        if (bytes > responseBufferedBytes || bytes > bufferedResponseBytes) {
          throw new Error('Response buffer reservation underflow');
        }
        bufferedResponseBytes -= bytes;
        responseBufferedBytes -= bytes;
      };
      const reserveAuxiliaryResponseBytes = bytes => {
        if (bytes <= 0) return true;
        if (bytes > maxBufferedResponseBytes - bufferedResponseBytes) return false;
        bufferedResponseBytes += bytes;
        auxiliaryResponseBytes += bytes;
        return true;
      };
      const releaseAuxiliaryResponseBytes = (bytes = auxiliaryResponseBytes) => {
        if (bytes <= 0) return;
        if (bytes > auxiliaryResponseBytes || bytes > bufferedResponseBytes) {
          throw new Error('Auxiliary response buffer reservation underflow');
        }
        bufferedResponseBytes -= bytes;
        auxiliaryResponseBytes -= bytes;
      };
      const reserveLogResponseBytes = bytes => {
        if (bytes <= 0) return true;
        if (bytes > maxBufferedResponseBytes - bufferedResponseBytes) return false;
        bufferedResponseBytes += bytes;
        logResponseBytes += bytes;
        return true;
      };
      const releaseLogResponseBytes = bytes => {
        if (bytes <= 0) return;
        if (bytes > logResponseBytes || bytes > bufferedResponseBytes) {
          throw new Error('Request log buffer reservation underflow');
        }
        bufferedResponseBytes -= bytes;
        logResponseBytes -= bytes;
      };
      const registerIdleLogReservation = release => {
        releaseIdleLogReservation = release;
        return () => {
          if (releaseIdleLogReservation === release) releaseIdleLogReservation = null;
        };
      };
      res.once('finish', releaseResponseBytes);
      res.once('close', releaseResponseBytes);
      bodyDeadline = startRequestBodyDeadline(req, res);
      try {
        const bodyRead = await readRequestBody(req, {
          maxBodyBytes,
          supervisedWorker,
          reserveRequestBytes,
          releaseRequestBytes,
        });
        if (bodyRead.error) {
          const headers = { 'Content-Type': 'application/json' };
          if (bodyRead.error.status === 429) headers['retry-after'] = '5';
          rejectEarlyRequest(req, res, bodyRead.error.status, headers, {
            type: 'error',
            error: {
              type: bodyRead.error.status === 429 ? 'rate_limit_error' : 'invalid_request_error',
              message: bodyRead.error.message,
            },
          });
          return;
        }
        let body = bodyRead.body;

        // Let client token refresh requests pass through to upstream untouched.
        // The proxy manages its own tokens via ensureTokenFresh(); intercepting
        // or rewriting client refreshes would cause token rotation conflicts.
        if (provider === 'anthropic'
            && req.method === 'POST' && req.url === '/v1/oauth/token') {
          await relayRaw(
            req,
            res,
            upstream,
            body,
            maxResponseBytes,
            upstreamResponseTimeoutMs,
            reserveResponseBytes,
            releaseReservedResponseBytes,
          );
          return; // outer finally decrements inFlightProxied
        }

        if (provider === 'codex') {
          body = normalizeCodexRequestBody(req, body);
        }

        // Track request
        const reqId = ++requestCounter;
        hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });

        // tried429/tried5xx/authRetried hold account OBJECTS (not indexes), and
        // `held` is the acquired account OBJECT — both stable across a concurrent
        // removeAccount() re-index, so a release/exclude can't target the wrong account.
        const ctx = { account: null, status: null, model: null, provider, authRetried: new Set(), tried429: new Set(), tried5xx: new Set(), overloadRetries: 0, capacityWaits: 0, held: null, queueTimeoutMs, abortSignal: null, affinityKey: sessionAffinity ? req.socket : null, preferredAccountUuid: recoveryAccountUuid, sawModelWeekly: false, continuity, continuityDeadlineAt: null, failedFast: false, last429: null, modelFallbacks: config.modelFallbacks || null, fallbackQueue: undefined, streamRecovery, maxResponseBytes, reserveResponseBytes, releaseReservedResponseBytes, reserveAuxiliaryResponseBytes, releaseAuxiliaryResponseBytes, reserveLogResponseBytes, releaseLogResponseBytes, registerIdleLogReservation, upstreamResponseTimeoutMs, streamIdleTimeoutMs, streamTotalTimeoutMs, subscriptionRecheckIntervalMs, resetCredits: resetCreditController, resetCreditAttempts: 0, resetCreditRetried: new Set() };
        try {
          if (isStatusRequest) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'invalid_request_error', message: 'Status requests must not include a body.' },
            }));
            return;
          }
          const requestModel = extractRequestModel(body);
          ctx.model = requestModel.model;
          ctx.advisorToolIndex = requestModel.advisorToolIndex;

          // Tie an abort signal to client disconnect so a request that's only
          // WAITING in the overflow queue is cancelled if the client goes away —
          // otherwise it would acquire a slot later and be dispatched upstream,
          // burning quota for a response nobody is listening for.
          const ac = new AbortController();
          const onClose = () => ac.abort();
          res.on('close', onClose);
          ctx.abortSignal = ac.signal;
          try {
            await forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
            // Stage + commit the warm-up template AFTER the response: only an
            // upstream-accepted shape (2xx via ctx.status) is trusted, and the
            // response also tells us whether this request's model tier reports
            // the model-scoped weekly windows (ctx.sawModelWeekly → the Fable
            // limit) — the one property worth a one-way template upgrade.
            if (ctx.advisorToolIndex == null
                && (!probeTemplate || probeTemplate._restored
                  || (!probeTemplate._elicitsModelWeekly && ctx.sawModelWeekly))) {
              const candidate = stageProbeTemplate(req, body);
              if (candidate) commitProbeTemplate(candidate, ctx.status, ctx.sawModelWeekly === true);
            }
          } finally {
            res.removeListener('close', onClose);
          }
        } catch (err) {
          if (bodyDeadline.didTimeout()) {
            ctx.status = 408;
          } else {
            ctx.status = ctx.status || 502;
            console.error('[TeamClaude] Unhandled error:', err);
            if (!res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                type: 'error',
                error: { type: 'proxy_error', message: 'Internal proxy error' },
              }));
            }
          }
        } finally {
          // Release the concurrency slot held by this request (if any). A failover
          // releases the previous account before re-acquiring, so at this point only
          // the last-held slot remains; releaseAccount guards against double-release.
          const servedAccount = ctx.held;
          if (ctx.held != null) {
            accountManager.releaseAccount(ctx.held);
            ctx.held = null;
          }
          // Codex fast-lane usage refresh for the account that just finished
          // serving — AFTER the slot release so it can never hold capacity,
          // and fire-and-forget so it can never delay this response.
          if (servedAccount != null) maybeRefreshCodexUsage(servedAccount);
          hooks.onRequestEnd?.(reqId, {
            method: req.method, path: req.url,
            account: ctx.account, status: ctx.status,
          });
        }
      } finally {
        bodyDeadline.cleanup();
        try {
          if (res.writableFinished || res.destroyed) releaseResponseBytes();
        } finally {
          try {
            releaseAuxiliaryResponseBytes();
          } finally {
            try {
              releaseRequestBytes(requestBufferedBytes);
            } finally {
              inFlightProxied--;
            }
          }
        }
      }
    } catch (err) {
      if (!bodyDeadline?.didTimeout()) {
        console.error('[TeamClaude] Unhandled error:', err);
      }
    }
  });

  // Shut warm-up down the instant a close is REQUESTED, not when the `'close'`
  // event finally fires — that waits for open keep-alive connections to drain,
  // and during that window the interval could still dispatch a credentialed
  // probe. Wrap server.close() to run the (idempotent) shutdown synchronously;
  // keep the `'close'` handler as a fallback for closes that bypass the method.
  // It stops scheduling new fan-outs (warmupClosed), aborts any in-flight /
  // scheduled probe (warmupAbort), and clears the periodic timer.
  const shutdownWarmup = () => {
    if (warmupClosed) return;
    warmupClosed = true;
    warmupAbort.abort();
    if (warmupTimer) clearInterval(warmupTimer);
    if (subscriptionRecheckTimer) clearInterval(subscriptionRecheckTimer);
    if (codexUsageTimer) clearInterval(codexUsageTimer);
  };
  const closeServer = server.close.bind(server);
  server.close = (cb) => { shutdownWarmup(); return closeServer(cb); };
  server.on('close', shutdownWarmup);

  // Exposed for the TUI Reload path (and tests): forced fleet-wide quota
  // re-measure. Kept off the HTTP surface — it spends real upstream requests,
  // so only a deliberate local action should trigger it.
  server.refreshQuotaAll = refreshQuotaAll;

  // Probe-template persistence (wired into the quota snapshot by index.js).
  // The template is the only known-accepted request shape — without persisting
  // it, a freshly restarted idle proxy can't probe at all: quota restores from
  // the snapshot (accounts read "measured"), no traffic flows, so forced
  // re-measure (TUI R) returns -1 until the first genuine request. Restoring
  // the last run's template closes that gap; it is marked `_restored` so the
  // first freshly accepted shape replaces it (see commitProbeTemplate).
  server.exportProbeTemplate = () => (probeTemplate ? { ...probeTemplate } : null);
  server.importProbeTemplate = (t) => {
    // Never clobber live evidence: a committed-in-this-process template wins.
    if (!activeWarmup || warmupClosed || probeTemplate) return false;
    if (!t || typeof t !== 'object' || typeof t.model !== 'string' || !t.model) return false;
    probeTemplate = {
      model: t.model,
      version: typeof t.version === 'string' && t.version ? t.version : '2023-06-01',
      beta: typeof t.beta === 'string' && t.beta ? t.beta : null,
      system: t.system ?? null,
      _elicitsModelWeekly: t._elicitsModelWeekly === true,
      _restored: true,
    };
    setImmediate(() => { recheckSubscriptionDisabled(); });
    return true;
  };

  return server;
}

async function readRequestBody(
  req,
  { maxBodyBytes, supervisedWorker, reserveRequestBytes, releaseRequestBytes },
) {
  const rawLength = req.headers['content-length'];
  if (rawLength !== undefined) {
    if (Array.isArray(rawLength) || !/^\d+$/.test(rawLength)) {
      return {
        error: { status: 400, message: 'Request Content-Length must be a non-negative integer.' },
      };
    }
    const expectedLength = Number(rawLength);
    if (!Number.isSafeInteger(expectedLength)) {
      return {
        error: { status: 400, message: 'Request Content-Length is outside the supported range.' },
      };
    }
    if (expectedLength > maxBodyBytes) {
      return {
        error: { status: 413, message: `Request body exceeds ${maxBodyBytes} bytes.` },
      };
    }
    if (!reserveRequestBytes(expectedLength)) {
      return {
        error: { status: 429, message: 'Proxy request buffer budget exhausted; retry shortly.' },
      };
    }

    const body = Buffer.allocUnsafe(expectedLength);
    let offset = 0;
    for await (const chunk of req) {
      if (chunk.length > expectedLength - offset) {
        return {
          error: { status: 400, message: 'Request body does not match Content-Length.' },
        };
      }
      chunk.copy(body, offset);
      offset += chunk.length;
    }
    if (offset !== expectedLength) {
      return {
        error: { status: 400, message: 'Request body does not match Content-Length.' },
      };
    }
    return { body };
  }

  if (supervisedWorker) {
    return {
      error: { status: 400, message: 'Supervised requests require an exact Content-Length.' },
    };
  }

  const bodyChunks = [];
  let bodyLen = 0;
  for await (const chunk of req) {
    bodyLen += chunk.length;
    if (bodyLen > maxBodyBytes) {
      return {
        error: { status: 413, message: `Request body exceeds ${maxBodyBytes} bytes.` },
      };
    }
    if (!reserveRequestBytes(chunk.length * 2)) {
      return {
        error: { status: 429, message: 'Proxy request buffer budget exhausted; retry shortly.' },
      };
    }
    bodyChunks.push(chunk);
  }
  const body = Buffer.concat(bodyChunks, bodyLen);
  bodyChunks.length = 0;
  releaseRequestBytes(bodyLen);
  return { body };
}

/**
 * Relay a request to upstream with no header rewriting — pure passthrough.
 */
async function relayRaw(
  req,
  res,
  upstream,
  body,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  upstreamResponseTimeoutMs = DEFAULT_UPSTREAM_RESPONSE_TIMEOUT_MS,
  reserveResponseBytes = () => true,
  releaseResponseBytes = () => {},
) {
  // Abort the relay if the client disconnects, so a hung upstream OAuth endpoint
  // can't pin this connection (and its admission-control inFlightProxied slot)
  // forever. Tied to res 'close'; the listener is removed once we're done.
  const ac = new AbortController();
  const onClose = () => ac.abort();
  res.on('close', onClose);
  const deadline = createUpstreamDeadline(ac.signal, upstreamResponseTimeoutMs);
  try {
    const requestHeaders = {};
    const connectionHeaders = connectionHeaderNames(req.headers.connection);
    for (const [key, value] of Object.entries(req.headers)) {
      const lowerKey = key.toLowerCase();
      if (HOP_BY_HOP_HEADERS.has(lowerKey) || connectionHeaders.has(lowerKey)) continue;
      if (lowerKey === 'x-api-key' || lowerKey === 'accept-encoding') continue;
      requestHeaders[key] = value;
    }
    if (!requestHeaders['content-type']) requestHeaders['content-type'] = 'application/json';
    if (!requestHeaders.accept) requestHeaders.accept = 'application/json';
    if (!requestHeaders['user-agent']) requestHeaders['user-agent'] = 'node';

    const upstreamRes = await fetch(`${upstream}${req.url}`, {
      method: req.method,
      headers: requestHeaders,
      body: body.length > 0 ? body : undefined,
      redirect: 'manual',
      signal: deadline.signal,
    });

    const responseBody = await readBodyBounded(
      upstreamRes.body,
      maxResponseBytes,
      reserveResponseBytes,
      releaseResponseBytes,
    );
    if (responseBody === null) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'proxy_error', message: 'Upstream response exceeded the proxy limit.' },
      }));
      return;
    }
    const responseHeaders = {};
    const responseConnectionHeaders = connectionHeaderNames(upstreamRes.headers.get('connection'));
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (HOP_BY_HOP_HEADERS.has(key) || responseConnectionHeaders.has(key)) continue;
      if (key === CODEX_RECOVERY_SESSION_HEADER) continue;
      if (key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.status, responseHeaders);
    res.end(responseBody);
  } catch (err) {
    if (deadline.timedOut && !res.destroyed) {
      console.error('[TeamClaude] Raw relay timed out while waiting for upstream response');
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'proxy_error', message: 'Upstream response timed out.' },
        }));
      }
      return;
    }
    // Client disconnected → we aborted the relay; nothing to respond to.
    if (ac.signal.aborted || res.destroyed) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    console.error('[TeamClaude] Raw relay error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  } finally {
    deadline.dispose();
    res.removeListener('close', onClose);
  }
}

function createUpstreamDeadline(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const abortFromParent = () => controller.abort();

  if (parentSignal?.aborted) {
    abortFromParent();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
  }

  const stopTimeout = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  return {
    signal: controller.signal,
    get timedOut() { return timedOut; },
    stopTimeout,
    dispose() {
      stopTimeout();
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function raceTimeout(promise, timeoutMs, message) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(message);
          err.code = 'ETIMEDOUT';
          reject(err);
        }, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function readBodyBounded(webStream, maxBytes, reserveBytes = () => true, releaseBytes = () => {}) {
  if (!webStream) return Buffer.alloc(0);
  const reader = webStream.getReader();
  const chunks = [];
  let totalBytes = 0;
  let reservedChunkBytes = 0;
  let finalReservedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (!reserveBytes(totalBytes)) {
          releaseBytes(reservedChunkBytes);
          reservedChunkBytes = 0;
          return null;
        }
        finalReservedBytes = totalBytes;
        let result;
        try {
          result = Buffer.concat(chunks, totalBytes);
        } catch (error) {
          releaseBytes(finalReservedBytes + reservedChunkBytes);
          finalReservedBytes = 0;
          reservedChunkBytes = 0;
          throw error;
        }
        releaseBytes(reservedChunkBytes);
        reservedChunkBytes = 0;
        finalReservedBytes = 0;
        return result;
      }
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes || !reserveBytes(chunk.length)) {
        await reader.cancel().catch(() => {});
        return null;
      }
      reservedChunkBytes += chunk.length;
      chunks.push(chunk);
    }
  } finally {
    if (reservedChunkBytes > 0) releaseBytes(reservedChunkBytes);
    reader.releaseLock();
  }
}

function isClaudeSubscriptionAccessDisabled(body) {
  try {
    const payload = JSON.parse(body.toString());
    return payload?.error?.type === 'permission_error'
      && payload?.error?.details?.error_code === 'oauth_not_allowed_for_organization';
  } catch {
    return false;
  }
}

function logTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

async function writeRequestLog(logDir, reqId, sections) {
  if (!logDir) return;
  const ts = logTimestamp();
  const filename = `${ts}_${String(reqId).padStart(5, '0')}.log`;
  let file = null;
  try {
    file = await open(join(logDir, filename), 'wx', 0o600);
    for (let index = 0; index < sections.length; index++) {
      if (index > 0) await file.write('\n\n');
      await file.write(sections[index]);
    }
  } catch (err) {
    console.error(`[TeamClaude] Failed to write log: ${err.message}`);
  } finally {
    await file?.close().catch(() => {});
  }
}

function flushRequestLog(logDir, reqId, sections, hooks) {
  if (!logDir || sections.flushing || sections.released || sections.length === 0) return;
  sections.flushing = true;
  void (async () => {
    try {
      await hooks.beforeRequestLogFlush?.();
      await writeRequestLog(logDir, reqId, sections);
    } finally {
      sections.release?.();
    }
  })().catch(err => {
    console.error(`[TeamClaude] Failed to flush log: ${err.message}`);
  });
}

function formatLogBody(heading, body) {
  if (body.length === 0) return `${heading}\n(empty)`;
  const logged = body.subarray(0, REQUEST_LOG_BODY_BYTES).toString('utf8');
  const truncation = body.length > REQUEST_LOG_BODY_BYTES
    ? `\n[log body truncated after ${REQUEST_LOG_BODY_BYTES} of ${body.length} bytes]`
    : '';
  return `${heading} (${body.length} bytes) ===\n${logged}${truncation}`;
}

async function writeStreamRequestLog(logDir, reqId, sections, heading, streamLog, truncation, hooks) {
  if (!logDir || sections.flushing) return;
  sections.flushing = true;
  const ts = logTimestamp();
  const filename = `${ts}_${String(reqId).padStart(5, '0')}.log`;
  let file = null;
  try {
    await hooks.beforeRequestLogFlush?.();
    file = await open(join(logDir, filename), 'wx', 0o600);
    for (let index = 0; index < sections.length; index++) {
      if (index > 0) await file.write('\n\n');
      await file.write(sections[index]);
    }
    if (sections.length > 0) await file.write('\n\n');
    await file.write(`${heading}\n`);
    for (const chunk of streamLog.chunks) await file.write(chunk);
    if (truncation) await file.write(truncation);
  } catch (err) {
    console.error(`[TeamClaude] Failed to write log: ${err.message}`);
  } finally {
    await file?.close().catch(() => {});
    sections.release?.();
  }
}

const CODEX_LOG_HEADER_ALLOWLIST = new Set([
  'accept',
  'content-length',
  'content-type',
  'retry-after',
  'user-agent',
]);

function formatHeaders(headers, metadataOnly = false) {
  const entries = headers.entries ? [...headers.entries()] : Object.entries(headers);
  const sensitive = /^(?:authorization|proxy-authorization|x-api-key|x-goog-api-key|chatgpt-account-id|cookie|set-cookie|(?:x-|openai-)?request-id)$/i;
  return entries
    .filter(([key]) => !sensitive.test(key)
      && (!metadataOnly || CODEX_LOG_HEADER_ALLOWLIST.has(key.toLowerCase())))
    .map(([key, value]) => `  ${key}: ${value}`)
    .join('\n');
}

function formatRequestUrlForLog(url, metadataOnly = false) {
  if (!metadataOnly) return url;
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

// Candidate transient statuses. A separate method gate permits internal
// failover/backoff only for replay-safe requests; an ambiguous POST passes
// through because a 5xx does not prove the upstream skipped its execution.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504, 507, 529]);
// Sleep that also resolves immediately if `signal` aborts — so a client that
// disconnects during an overload backoff doesn't keep its account slot reserved
// for the whole (up to multi-second) wait. Cleans up its timer/listener either way.
function sleepOrAbort(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const cleanup = () => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => { cleanup(); resolve(); };
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Await `promise`, but stop waiting the instant `signal` aborts (client gone).
// The underlying op (e.g. a coalesced token refresh shared by other requests)
// is NOT cancelled — we only stop *this* request from blocking on it, so its
// account slot can be released promptly. Rejections still propagate.
function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => { cleanup(); resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { cleanup(); resolve(v); },
      (e) => { cleanup(); reject(e); },
    );
  });
}

// parseInt with a default that HONORS an explicit 0 — unlike `parseInt(...) || def`,
// which discards a valid 0 (0 is falsy). e.g. TEAMCLAUDE_OVERLOAD_RETRIES=0 must
// actually disable proxy-held backoff retries during an incident, not fall back to
// the default. Mirrors the Number.isFinite guard used for reevalIntervalMs in index.js.
const envInt = (name, def) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
};

function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value == null || value === '') return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : 0;
}

function extractRequestModel(body) {
  try {
    const json = JSON.parse(body.toString());
    const advisorToolIndex = Array.isArray(json?.tools)
      ? json.tools.findIndex(tool =>
        tool && typeof tool === 'object'
        && typeof tool.type === 'string' && tool.type.startsWith('advisor_')
        && typeof tool.model === 'string' && tool.model.length > 0)
      : -1;
    if (advisorToolIndex >= 0) {
      return { model: json.tools[advisorToolIndex].model, advisorToolIndex };
    }
    return {
      model: typeof json?.model === 'string' ? json.model : null,
      advisorToolIndex: null,
    };
  } catch {
    return { model: null, advisorToolIndex: null };
  }
}

// Codex runtimes can retain deprecated request fields after a model upgrade.
// Remove only the known-incompatible field; implicit prompt caching remains
// available and no unsupported TTL is guessed on the client's behalf.
function normalizeCodexRequestBody(req, body) {
  let json;
  try {
    json = JSON.parse(body.toString());
  } catch {
    return body;
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)
      || !Object.hasOwn(json, 'prompt_cache_retention')) return body;
  delete json.prompt_cache_retention;
  const normalizedBody = Buffer.from(JSON.stringify(json));
  req.headers['content-length'] = String(normalizedBody.length);
  return normalizedBody;
}

function isCodexChatGptModelUnsupported(body, model) {
  if (typeof model !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(model)) return false;
  let payload;
  try {
    payload = JSON.parse(body.toString());
  } catch {
    return false;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).length !== 1) return false;
  return payload.detail === `The '${model}' model is not supported when using Codex with a ChatGPT account.`;
}

// --- Model fallback (config.modelFallbacks) --------------------------------
// When the whole fleet is out of quota for the REQUESTED model, the proxy can
// rewrite the request to a configured fallback model and retry the fleet,
// instead of surfacing a 429 that kills the client's turn:
//   "modelFallbacks": { "claude-fable-5": ["claude-opus-4-8", "claude-sonnet-5"] }
// The chain is resolved ONCE per request from the original model (fallbacks of
// fallbacks are not followed) and consumed in order; when it runs dry the
// request falls through to the pre-existing 429 behavior unchanged. Lookup
// tolerates a client-side bracket suffix ("claude-fable-5[1m]") by retrying
// with the suffix stripped — the API itself knows no bracketed model IDs
// (probed 2026-07-13: "claude-opus-4-8[1m]" → not_found_error), so configured
// targets must be plain model IDs.
function resolveModelFallbacks(modelFallbacks, model) {
  if (!modelFallbacks || typeof modelFallbacks !== 'object' || !model) return null;
  let chain = modelFallbacks[model];
  if (!Array.isArray(chain)) {
    const stripped = model.replace(/\[[^\]]*\]$/, '');
    if (stripped !== model) chain = modelFallbacks[stripped];
  }
  if (!Array.isArray(chain)) return null;
  const filtered = chain.filter(m => typeof m === 'string' && m && m !== model);
  return filtered.length ? filtered : null;
}

// Advance to the next fallback model: returns { model, body } with the request
// body's `model` field rewritten, or null when no fallback remains / applies.
// Side effect: keeps req.headers' content-length honest for the rewritten body
// (content-length is NOT hop-by-hop, so the upstream re-dispatch copies it —
// a mismatch would make undici reject the request outright).
function nextModelFallback(ctx, req, body) {
  if (ctx.fallbackQueue === undefined) {
    ctx.fallbackQueue = resolveModelFallbacks(ctx.modelFallbacks, ctx.model);
  }
  while (ctx.fallbackQueue && ctx.fallbackQueue.length) {
    const next = ctx.fallbackQueue.shift();
    if (next === ctx.model) continue;
    let json;
    try {
      json = JSON.parse(body.toString());
    } catch {
      return null;
    }
    const target = ctx.advisorToolIndex == null
      ? json
      : json?.tools?.[ctx.advisorToolIndex];
    if (typeof target?.model !== 'string') return null;
    target.model = next;
    const newBody = Buffer.from(JSON.stringify(json));
    if (req.headers['content-length'] != null) {
      req.headers['content-length'] = String(newBody.length);
    }
    return { model: next, body: newBody };
  }
  return null;
}

function logModelFallback(ctx, fallback, reason) {
  const decision = ctx.provider === 'codex' ? 'codex-model-fallback' : 'Model fallback';
  console.log(`[TeamClaude] ${decision}: ${ctx.model} → ${fallback.model} (${reason})`);
}

function startContinuityDeadline(ctx) {
  if (ctx.continuity.maxWaitMs <= 0) return null;
  if (ctx.continuityDeadlineAt == null) {
    ctx.continuityDeadlineAt = Date.now() + ctx.continuity.maxWaitMs;
  }
  return ctx.continuityDeadlineAt;
}

function sendSaved429(res, ctx) {
  if (!ctx.last429 || res.destroyed || res.headersSent) return false;
  ctx.status = 429;
  res.writeHead(429, ctx.last429.headers);
  res.end(ctx.last429.body.length > 0 ? ctx.last429.body : undefined);
  return true;
}

function sendUpstreamTimeout(res, ctx, headers = { 'Content-Type': 'application/json' }) {
  if (res.destroyed || res.headersSent) return false;
  ctx.status = 502;
  res.writeHead(502, headers);
  res.end(JSON.stringify({
    type: 'error',
    error: { type: 'proxy_error', message: 'Upstream response timed out.' },
  }));
  return true;
}

function codexRecoveryResponseHeaders(req, body, ctx, method, headers = {}) {
  const identity = ctx.provider === 'codex' && method === 'POST'
      && isCodexResponsesPath(req.url)
    ? codexRecoveryIdentity(req.headers, body)
    : null;
  if (identity) headers['X-TeamCodex-Recovery-Session'] = identity.sessionId;
  return headers;
}

async function forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir) {
  const maxRetries = accountManager.accounts.length;
  if (ctx.provider === 'codex' && ctx.credentialType == null
      && accountManager.accounts.some(candidate => candidate.type === 'oauth'
        && accountManager._isModelUnsupported(candidate, ctx.model))) {
    ctx.credentialType = 'oauth';
  }
  const requestExclusions = (extra = null) => {
    const excluded = new Set(extra || []);
    if (ctx.provider === 'codex' && ctx.credentialType != null) {
      for (const candidate of accountManager.accounts) {
        if (candidate.type !== ctx.credentialType) excluded.add(candidate);
      }
    }
    return excluded.size > 0 ? excluded : null;
  };
  const hasUsable = extra => accountManager.anyUsable(requestExclusions(extra), ctx.model);
  const hasCapped = extra => accountManager.anyCapped(requestExclusions(extra), ctx.model);
  const fleetModelQuarantined = () => {
    const candidates = accountManager.accounts.filter(candidate =>
      candidate.enabled !== false
      && candidate.status !== 'error'
      && (ctx.provider !== 'codex' || ctx.credentialType == null
        || candidate.type === ctx.credentialType));
    return candidates.length > 0
      && candidates.every(candidate => accountManager._isModelUnsupported(candidate, ctx.model));
  };
  const canUsePreDispatchFallback = () => ctx.provider !== 'codex'
    || fleetModelQuarantined();

  // Reserve a per-account concurrency slot. On a 401 same-account refresh-retry
  // the slot is already held (ctx.held set, exclude unchanged) → reuse it.
  // Otherwise acquire a fresh slot, waiting briefly if every available account is
  // at its cap (overflow queue) before giving up with a 429. Releasing this slot
  // before any account-switching retry is the caller's job, via releaseHeld().
  let account;
  while (!account) {
    if (ctx.continuity.enabled) {
      const waited = await ctx.continuity.waitGlobal(ctx.abortSignal, ctx);
      if (!waited) break;
    }
    if (ctx.abortSignal?.aborted || res.destroyed) return;

    // On a failover retry, skip accounts already tried for this request.
    const excludeForSelect = requestExclusions(new Set([...ctx.tried429, ...ctx.tried5xx]));
    if (ctx.held != null) {
      account = ctx.held;
    } else {
      // A continuity request must keep its FIFO position while the fleet is
      // merely concurrency-capped. Re-applying the short overflow timeout on
      // every loop removes the waiter and appends it at the back again, so a
      // saturated fleet can starve an older request indefinitely. The overall
      // continuity deadline already bounds this wait; client abort still
      // removes it immediately. Preserve an explicit queueTimeoutMs: 0 opt-out.
      let acquireTimeoutMs = ctx.queueTimeoutMs;
      const preferred = typeof ctx.preferredAccountUuid === 'string'
        ? accountManager.accounts.find(a => a.accountUuid === ctx.preferredAccountUuid)
        : null;
      const selectionHasUsable = ctx.preferredAccountUuid == null
        ? hasUsable(excludeForSelect)
        : preferred && accountManager._isAvailable(preferred, ctx.model)
          && accountManager._hasCapacity(preferred)
          && !(excludeForSelect && excludeForSelect.has(preferred));
      const selectionHasCapped = ctx.preferredAccountUuid == null
        ? hasCapped(excludeForSelect)
        : preferred && accountManager._isAvailable(preferred, ctx.model)
          && !accountManager._hasCapacity(preferred)
          && !(excludeForSelect && excludeForSelect.has(preferred));
      if (acquireTimeoutMs > 0 && ctx.continuity.enabled && ctx.continuity.maxWaitMs > 0
          && !selectionHasUsable && selectionHasCapped) {
        acquireTimeoutMs = Math.max(0, startContinuityDeadline(ctx) - Date.now());
      }
      account = await accountManager.acquireAccount(
        excludeForSelect,
        acquireTimeoutMs,
        ctx.abortSignal,
        ctx.affinityKey,
        ctx.model,
        ctx.preferredAccountUuid,
      );
      if (account) {
        ctx.held = account;
      }
    }

    if (account || ctx.abortSignal?.aborted || res.destroyed) break;

    const accts = ctx.provider === 'codex' && ctx.credentialType != null
      ? accountManager.accounts.filter(candidate => candidate.type === ctx.credentialType)
      : accountManager.accounts;
    const allAuthFailed = accts.length > 0 && accts.every(a => a.status === 'error');
    const modelDeadEnd = !hasUsable(null) && !hasCapped(null);
    // Quota dead end with automatic reset credits on: redeem a "Full reset"
    // on the best exhausted account and re-acquire, BEFORE any model fallback
    // or the fail-fast 429 — the operator asked for the pool to keep serving
    // the requested model while credits remain. Bounded per request by the
    // pool size; each pass already walks every eligible candidate.
    // ONE fleet pass per request: if the reset account still 429s afterwards
    // (backend did not honour the reset), the request must fail fast rather
    // than walk the pool spending one credit per account. A fleet-wide model
    // quarantine is not a quota problem — let the model fallback handle it.
    if (!allAuthFailed && modelDeadEnd && ctx.resetCredits
        && ctx.resetCreditAttempts < 1 && !fleetModelQuarantined()) {
      const pass = await ctx.resetCredits.fleet(
        accts,
        'fleet-exhausted',
        ctx.model,
        () => hasUsable(null) || hasCapped(null), // request-scoped "dead end resolved?"
      );
      // Only spend-capable work uses up the pass; a walk that found no
      // eligible candidate leaves it for a later account-policy redemption.
      if (pass.chargePass) ctx.resetCreditAttempts += 1;
      if (ctx.abortSignal?.aborted || res.destroyed) return;
      if (pass.redeemed) {
        ctx.tried429.clear();
        ctx.tried5xx.clear();
        retryCount = 0;
        continue;
      }
    }
    if (!allAuthFailed && modelDeadEnd && canUsePreDispatchFallback()) {
      const fallback = nextModelFallback(ctx, req, body);
      if (fallback) {
        logModelFallback(ctx, fallback, `no usable account for ${ctx.model}`);
        ctx.model = fallback.model;
        ctx.tried429.clear();
        ctx.tried5xx.clear();
        return forwardRequest(req, res, fallback.body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
      }
    }
    const canEventuallyRecover = accts.some(a => a.enabled !== false && a.status !== 'error');
    const modelQuarantined = fleetModelQuarantined();
    if (modelQuarantined) break;
    if (allAuthFailed || !ctx.continuity.enabled || !canEventuallyRecover) break;

    const status = accountManager.getStatus();
    const capped = hasCapped(null);
    const recovery = capped
      ? null
      : fleetRecovery(status.accounts, accountManager.switchThreshold, ctx.model);
    const retryAfter = capped ? 1 : recovery.retryAfter;
    const deadlineMode = ctx.continuity.maxWaitMs > 0;
    const maxCapacityWaits = Math.max(0, envInt('TEAMCLAUDE_OVERLOAD_RETRIES', 6));
    if (!deadlineMode && ctx.capacityWaits >= maxCapacityWaits) break;
    // Fail fast when waiting cannot help: the fleet is blocked by a KNOWN quota
    // reset (not merely at its concurrency cap, and not the 60s quota-healthy
    // fallback — an account excluded by a bare 429 may free up any second) and
    // that reset lies beyond the remaining continuity budget — e.g. every
    // account spent its WEEKLY window and the reset is days away. Polling until
    // the deadline would only hold the client for the full budget before
    // returning the very same 429 (2026-09-04). Finalize exactly as the
    // deadline would (`failedFast` → saved upstream 429 replay still wins).
    if (deadlineMode && recovery?.soonestKnown) {
      const remainingMs = startContinuityDeadline(ctx) - Date.now();
      if (recovery.soonestMs > remainingMs) {
        console.log(`[TeamClaude] No eligible capacity${ctx.model ? ` for ${ctx.model}` : ''} — soonest recovery in ${retryAfter}s exceeds the ${Math.max(0, remainingMs)}ms continuity budget; failing fast`);
        ctx.failedFast = true;
        break;
      }
    }
    console.log(`[TeamClaude] No eligible capacity${ctx.model ? ` for ${ctx.model}` : ''} — waiting ${Math.min(retryAfter * 1000, ctx.continuity.maxSleepMs)}ms`);
    ctx.capacityWaits += 1;
    const waited = await ctx.continuity.waitFor(
      retryAfter,
      ctx.abortSignal,
      deadlineMode ? startContinuityDeadline(ctx) : null,
    );
    if (!waited) break;
    ctx.tried429.clear();
    ctx.tried5xx.clear();
    retryCount = 0;
  }
  const releaseHeld = () => {
    if (ctx.held != null) {
      accountManager.releaseAccount(ctx.held);
      ctx.held = null;
    }
  };

  // The client disconnected while this request was queued (acquireAccount was
  // cancelled by the abort signal) — nothing to respond to.
  if (!account && (ctx.abortSignal?.aborted || res.destroyed)) return;

  if (!account) {
    ctx.account = '(none available)';
    // If every account is in auth-error state, this is an authentication
    // problem (revoked/expired tokens needing re-login), not a rate limit —
    // return 401 so the client surfaces it instead of pointlessly backing off.
    const accts = ctx.provider === 'codex' && ctx.credentialType != null
      ? accountManager.accounts.filter(candidate => candidate.type === ctx.credentialType)
      : accountManager.accounts;
    if (accts.length > 0 && accts.every(a => a.status === 'error')) {
      ctx.status = 401;
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'authentication_error',
          message: `All ${accts.length} accounts failed authentication. Re-login required.`,
        },
      }));
      return;
    }
    // Fleet-wide dead end at selection time. If the REQUESTED model has no
    // usable account (model-tier or full exhaustion — not a mere concurrency
    // queue timeout, which must never silently change the client's model),
    // walk the configured fallback chain before surfacing a 429.
    if (!res.destroyed
        && !hasUsable(null)
        && !hasCapped(null)
        && canUsePreDispatchFallback()) {
      const fallback = nextModelFallback(ctx, req, body);
      if (fallback) {
        logModelFallback(ctx, fallback, `no usable account for ${ctx.model}`);
        ctx.model = fallback.model;
        ctx.tried429.clear();
        ctx.tried5xx.clear();
        return forwardRequest(req, res, fallback.body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
      }
    }
    const deadlineExpired = ctx.continuity.maxWaitMs > 0
      && ctx.continuityDeadlineAt != null
      && Date.now() >= ctx.continuityDeadlineAt;
    if ((deadlineExpired || ctx.failedFast) && sendSaved429(res, ctx)) return;
    ctx.status = 429;
    // Internal snapshot: identity is needed only to attribute the plan of the
    // soonest-recovering account; it never leaves the process.
    const status = accountManager.getStatus({ includeIdentity: true });
    const recovery = fleetRecovery(status.accounts, accountManager.switchThreshold, ctx.model);
    // A fleet-wide model quarantine (unsupported-model 400 contract) is not a
    // usage limit: keep its own retry-after and the generic body.
    const quarantineRetryAfter = modelQuarantineRetryAfter(accts, ctx.model);
    const retryAfter = quarantineRetryAfter ?? recovery.retryAfter;
    // Codex-native exhaustion body. The Codex CLI cannot read the generic
    // rate_limit_error above ("exceeded retry limit, last status: 429"); it DOES
    // natively render a 429 whose body is {error:{type:"usage_limit_reached",
    // resets_at:<unix seconds>, plan_type}} ("You've hit your usage limit …
    // try again at <time>"). Only for a QUOTA dead end (never a concurrency
    // queue timeout) and only in deadline mode — the path the fail-fast above
    // short-circuits; legacy polling keeps its historical body.
    if (quarantineRetryAfter == null && ctx.provider === 'codex' && ctx.continuity.enabled && ctx.continuity.maxWaitMs > 0
        && !hasUsable(null)
        && !hasCapped(null)) {
      const resetsAt = Math.floor(Date.now() / 1000) + retryAfter;
      const planType = codexPoolPlanType(accountManager.accounts, recovery.soonestName);
      res.writeHead(429, {
        'Content-Type': 'application/json',
        'retry-after': String(retryAfter),
      });
      res.end(JSON.stringify({
        error: {
          type: 'usage_limit_reached',
          message: `TeamCodex pool exhausted: all ${accts.length} accounts have hit their usage limit. Resets at ${new Date(resetsAt * 1000).toISOString()} (in ${retryAfter}s).`,
          ...(planType ? { plan_type: planType } : {}),
          resets_at: resetsAt,
        },
      }));
      return;
    }
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'retry-after': String(retryAfter),
    });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: `All ${accts.length} accounts exhausted. Retry in ${retryAfter}s.`,
      },
    }));
    return;
  }

  // Track which account handles this request
  if (ctx.provider === 'codex' && ctx.credentialType == null) {
    ctx.credentialType = account.type;
  }
  ctx.account = account.name;
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // Refresh OAuth token if needed. Stop waiting if the client disconnects (the
  // refresh is coalesced/shared, so we don't cancel it — we just don't pin this
  // request's account slot on a possibly-hung token endpoint).
  await raceAbort(accountManager.ensureTokenFresh(account), ctx.abortSignal);
  if (res.destroyed || ctx.abortSignal?.aborted) return; // client gone — outer finally frees the slot

  if (typeof ctx.preferredAccountUuid === 'string') {
    const preferredStillEligible = account.accountUuid === ctx.preferredAccountUuid
      && accountManager.accounts[account.index] === account
      && accountManager._isAvailable(account, ctx.model);
    if (!preferredStillEligible) {
      releaseHeld();
      ctx.status = 409;
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'no_alternative_account',
          message: 'Selected Claude recovery account became unavailable before dispatch.',
        },
      }));
      return;
    }
  }

  // The account may have been REMOVED (TUI/CLI delete) during the awaited refresh
  // above (or the 401 forced-refresh that recurses back here). A detached account
  // must not be used to dispatch upstream — its slot release is a no-op and we'd
  // be sending traffic on a credential the operator just retired. Re-select a live
  // account instead. (accounts[i] === account holds only while it's still live.)
  if (accountManager.accounts[account.index] !== account) {
    releaseHeld();
    if (res.destroyed) return; // client gone — outer finally cleans up
    if (retryCount < maxRetries) {
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
    }
    // Out of retry budget after repeated removals — respond rather than hang.
    ctx.status = 503;
    if (!res.headersSent) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'retry-after': '5' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Account removed mid-request; retry shortly.' },
      }));
    }
    return;
  }

  if (account.status === 'error' && retryCount < maxRetries) {
    releaseHeld(); // failing over to a different account
    return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
  }

  // Build upstream request headers
  const isOAuth = account.type === 'oauth';
  const headers = {};
  const connectionHeaders = connectionHeaderNames(req.headers.connection);
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk) || connectionHeaders.has(lk)) continue;
    if (lk === 'x-api-key') continue;
    if (lk === 'authorization') continue;
    if (lk === 'chatgpt-account-id') continue;
    if (lk === CODEX_INVOCATION_HEADER) continue;
    // Strip accept-encoding: Node fetch auto-decompresses, which would
    // mismatch the Content-Encoding header we forward to the client
    if (lk === 'accept-encoding') continue;
    headers[key] = value;
  }

  if (ctx.provider === 'codex') {
    headers['authorization'] = `Bearer ${account.credential}`;
    if (account.accountId) headers['chatgpt-account-id'] = account.accountId;
  } else if (isOAuth) {
    headers['authorization'] = `Bearer ${account.credential}`;
  } else {
    headers['x-api-key'] = account.credential;
  }

  const hasDuplicatedCodexPrefix = ctx.provider === 'codex'
    && /\/codex\/?$/.test(new URL(upstream).pathname)
    && req.url.startsWith('/codex/');
  const upstreamUrl = hasDuplicatedCodexPrefix
    ? `${upstream.replace(/\/$/, '')}${req.url.slice('/codex'.length)}`
    : `${upstream}${req.url}`;
  const method = req.method;
  const replaySafe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  const metadataOnlyLog = ctx.provider === 'codex';

  // Build log sections
  const logSections = [];
  let logSectionBytes = 0;
  let logSectionReleased = false;
  let unregisterIdleLogReservation = () => {};
  logSections.release = () => {
    if (logSectionReleased) return;
    logSectionReleased = true;
    logSections.released = true;
    unregisterIdleLogReservation();
    ctx.releaseLogResponseBytes(logSectionBytes);
    logSectionBytes = 0;
    logSections.length = 0;
  };
  const appendLogSection = section => {
    if (!logDir || logSections.flushing || logSectionReleased) return false;
    const separatorBytes = logSections.length > 0 ? 2 : 0;
    const sectionBytes = Buffer.byteLength(section) + separatorBytes;
    if (!ctx.reserveLogResponseBytes(sectionBytes)) return false;
    logSectionBytes += sectionBytes;
    logSections.push(section);
    return true;
  };
  unregisterIdleLogReservation = ctx.registerIdleLogReservation(() => {
    if (logSections.flushing || logSectionReleased) return false;
    logSections.release();
    return true;
  });
  if (logDir) {
    appendLogSection(
      `=== REQUEST (account: pool-${account.index}, retry: ${retryCount}) ===\n${method} ${formatRequestUrlForLog(upstreamUrl, metadataOnlyLog)}\n${formatHeaders(headers, metadataOnlyLog)}`,
    );
    if (!metadataOnlyLog && body.length > 0) {
      appendLogSection(formatLogBody('=== REQUEST BODY', body));
    }
  }

  const continuityRemainingMs = ctx.continuityDeadlineAt == null
    ? null
    : Math.max(0, ctx.continuityDeadlineAt - Date.now());
  if (continuityRemainingMs != null && continuityRemainingMs <= 1) {
    try {
      if (ctx.abortSignal?.aborted || res.destroyed) return;
      if (sendSaved429(res, ctx)) return;
      sendUpstreamTimeout(res, ctx);
      return;
    } finally {
      logSections.release();
    }
  }
  const continuityBoundedTimeout = continuityRemainingMs != null
    && continuityRemainingMs <= ctx.upstreamResponseTimeoutMs;
  const upstreamDeadline = createUpstreamDeadline(
    ctx.abortSignal,
    continuityBoundedTimeout ? continuityRemainingMs : ctx.upstreamResponseTimeoutMs,
  );
  try {
    const requestOptions = {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : body,
      signal: upstreamDeadline.signal,
    };
    const dispatchedAt = Date.now();
    const upstreamRequest = ctx.provider === 'codex'
      ? requestUpstreamRaw(upstreamUrl, requestOptions)
      : fetch(upstreamUrl, { ...requestOptions, redirect: 'manual' });
    ctx.preferredAccountUuid = null;
    const upstreamRes = await upstreamRequest;
    const isStreaming = isEventStream(upstreamRes.headers.get('content-type'));
    if (isStreaming && upstreamRes.status !== 429) upstreamDeadline.stopTimeout();
    // A response to a request dispatched BEFORE this account's reset credit
    // landed describes the pre-reset meter (e.g. a 429 that was already in
    // flight on the last healthy account). Its x-codex headers must not
    // re-mark the freshly reset account as exhausted, and a 429 from it is
    // retried rather than throttled — otherwise the fleet would burn a second
    // credit on another account for a window that is already open.
    const staleAfterReset = ctx.provider === 'codex'
      && Number.isFinite(account.quota?.codexResetCreditResetAt)
      && dispatchedAt < account.quota.codexResetCreditResetAt;
    // Inside the post-reset grace an ACCEPTED (non-429) response may still
    // carry the pre-reset meter in its x-codex-* headers; folding it would
    // re-mark the reset account at 100% and the authoritative poll could no
    // longer lower it (it only refuses to RAISE). A 429 is folded regardless:
    // the rejection itself is the evidence that the reset did not take.
    const holdHeaderFold = staleAfterReset
      || (ctx.provider === 'codex' && upstreamRes.status !== 429
        && withinCodexResetCreditGrace(account.quota));

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key.startsWith('anthropic-ratelimit-') || key.startsWith('x-codex-')) {
        rateLimitHeaders[key] = value;
      }
    }
    // Did this request's model tier report a model-scoped weekly window
    // (anthropic-ratelimit-unified-7d_<label>-*)? Only such requests can teach
    // probes to refresh the Fable weekly numbers — used by the template-upgrade
    // decision in the request handler. Request-scoped: any attempt's headers
    // prove the property, since the request shape is identical across failovers.
    if (Object.keys(rateLimitHeaders).some(k => k.startsWith('anthropic-ratelimit-unified-7d_'))) {
      ctx.sawModelWeekly = true;
    }
    // A held fold still records the request itself (usage counters / lastUsed
    // live in updateQuota): fold an empty header set instead of skipping.
    accountManager.updateQuota(account, holdHeaderFold ? {} : rateLimitHeaders);
    // 401 = auth failure (stale or revoked token). For OAuth, attempt one
    // forced token refresh and retry the same account (the token may be stale
    // but still refreshable). If that doesn't fix it — refresh fails, the token
    // is revoked, or it's an API-key account — mark the account 'error' so it's
    // excluded from BOTH selection and warm-up, then switch to another account.
    // Without this, warm-up would keep routing client traffic to a revoked
    // account (it stays unmeasured/active), yielding repeated 401s.
    if (upstreamRes.status === 401) {
      await upstreamRes.body?.cancel();

      if (account.type === 'oauth' && account.refreshToken
          && !ctx.authRetried.has(account)
          && retryCount < maxRetries && !res.destroyed) {
        ctx.authRetried.add(account);
        console.log(`[TeamClaude] 401 on "${account.name}" — forcing token refresh and retrying`);
        await raceAbort(accountManager.ensureTokenFresh(account, true), ctx.abortSignal);
        if (res.destroyed || ctx.abortSignal?.aborted) return; // client gone during refresh
        // ensureTokenFresh only marks 'error' for an expired token; a successful
        // (or non-fatal) refresh leaves status intact → retry the same account.
        if (account.status !== 'error') {
          if (logDir) {
            appendLogSection(`=== RESPONSE 401 — forced token refresh, retrying ===`);
            flushRequestLog(logDir, reqId, logSections, hooks);
          }
          return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
        }
      }

      // Refresh didn't help (failed / already retried / revoked-but-unexpired)
      // or it's an API-key account — fail this account out and switch.
      if (account.status !== 'error') {
        accountManager.markAuthenticationError(account, 'auth-revoked');
        console.log(`[TeamClaude] 401 on "${account.name}" — auth failed, marking account error`);
      } else if (account.expiresAt && Date.now() < normalizeExpiresAt(account.expiresAt)) {
        // A 401 on a still-valid token is account-level rejection evidence.
        // It must override a refresh-failure label so the sweep cannot revive it.
        accountManager.markAuthenticationError(account, 'auth-revoked');
      }
      await accountManager.waitForAccountFlag(account).catch(err => {
        console.error(`[TeamClaude] Failed to persist subscription state for "${account.name}": ${err.message}`);
      });
      if (logDir) {
        appendLogSection(`=== RESPONSE 401 — auth failure, account marked error ===\n${formatHeaders(upstreamRes.headers, metadataOnlyLog)}`);
        flushRequestLog(logDir, reqId, logSections, hooks);
      }
      if (res.destroyed) return;
      if (retryCount < maxRetries) {
        releaseHeld(); // this account is now 'error'; fail over to another
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
      }
      // Every account failed auth — surface the 401 to the client.
      ctx.status = 401;
      if (!res.headersSent) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'All accounts failed authentication.' },
        }));
      }
      return;
    }

    // Anthropic returns a completed 403 when an OAuth account's organization
    // has disabled Claude Code subscription access. This is account-scoped and
    // safe to replay: the upstream explicitly rejected the request before doing
    // work. Match the product-specific JSON message narrowly; unrelated 403s
    // remain byte-preserving pass-through responses and do not poison the pool.
    if (ctx.provider === 'anthropic' && upstreamRes.status === 403 && account.type === 'oauth') {
      const responseBody = await readBodyBounded(
        upstreamRes.body,
        ctx.maxResponseBytes,
        ctx.reserveResponseBytes,
        ctx.releaseReservedResponseBytes,
      );
      if (responseBody === null) {
        ctx.status = 502;
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'proxy_error', message: 'Upstream 403 response exceeded the proxy limit.' },
          }));
        }
        return;
      }

      const subscriptionDisabled = isClaudeSubscriptionAccessDisabled(responseBody);
      if (subscriptionDisabled) {
        // Park + persist: marks the account error (refresh sweeps and
        // _recoverSoonest cannot revive it) and mirrors the flag into config
        // via the onAccountFlag hook, so a restart keeps the lapsed label
        // instead of resetting to active until the next 403.
        accountManager.setSubscriptionDisabled(account, true);
        if (ctx.subscriptionRecheckIntervalMs > 0) {
          account._subscriptionRecheckAt = Date.now() + ctx.subscriptionRecheckIntervalMs;
        }
        const flagPersisted = await accountManager.waitForAccountFlag(account).then(
          () => true,
          err => {
            console.error(`[TeamClaude] Failed to persist subscription state for "${account.name}": ${err.message}`);
            return false;
          },
        );
        console.log(`[TeamClaude] 403 subscription access disabled on "${account.name}" — marking account error and switching`);
        if (logDir) {
          appendLogSection(`=== RESPONSE 403 — subscription access disabled, account marked error ===\n${formatHeaders(upstreamRes.headers, metadataOnlyLog)}`);
          flushRequestLog(logDir, reqId, logSections, hooks);
        }
        if (res.destroyed) return;
        const hasAlternative = hasUsable(null) || hasCapped(null);
        if (flagPersisted && retryCount < maxRetries && hasAlternative) {
          releaseHeld();
          return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
        }
      }

      ctx.status = 403;
      const responseHeaders = {};
      const responseConnectionHeaders = connectionHeaderNames(upstreamRes.headers.get('connection'));
      for (const [key, value] of upstreamRes.headers.entries()) {
        if (HOP_BY_HOP_HEADERS.has(key) || responseConnectionHeaders.has(key)) continue;
        if (key === CODEX_RECOVERY_SESSION_HEADER) continue;
        if (key === 'content-encoding' || key === 'content-length') continue;
        responseHeaders[key] = value;
      }
      if (logDir && !subscriptionDisabled) {
        appendLogSection(`=== RESPONSE 403 ===\n${formatHeaders(upstreamRes.headers, metadataOnlyLog)}`);
        if (!metadataOnlyLog) appendLogSection(formatLogBody('=== RESPONSE BODY', responseBody));
        flushRequestLog(logDir, reqId, logSections, hooks);
      }
      if (!res.headersSent) res.writeHead(403, responseHeaders);
      res.end(responseBody.length > 0 ? responseBody : undefined);
      return;
    }

    if (ctx.provider === 'codex' && upstreamRes.status === 400 && account.type === 'oauth') {
      const responseBody = await readBodyBounded(
        upstreamRes.body,
        ctx.maxResponseBytes,
        ctx.reserveResponseBytes,
        ctx.releaseReservedResponseBytes,
      );
      if (responseBody === null) {
        ctx.status = 502;
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'proxy_error', message: 'Upstream 400 response exceeded the proxy limit.' },
          }));
        }
        return;
      }

      let modelUnsupported = false;
      if (ctx.reserveAuxiliaryResponseBytes(CODEX_ERROR_INSPECTION_MAX_BYTES)) {
        try {
          const inspectionBody = decodeBodyForInspection(
            responseBody,
            upstreamRes.headers.get('content-encoding'),
            CODEX_ERROR_INSPECTION_MAX_BYTES,
          );
          modelUnsupported = inspectionBody != null
            && isCodexChatGptModelUnsupported(inspectionBody, ctx.model);
        } finally {
          ctx.releaseAuxiliaryResponseBytes(CODEX_ERROR_INSPECTION_MAX_BYTES);
        }
      }
      if (modelUnsupported) {
        accountManager.markModelUnsupported(account, ctx.model);
        console.log(`[TeamClaude] codex-model-unsupported for ${ctx.model} — quarantined; POST was not replayed`);
      }

      ctx.status = 400;
      const responseHeaders = {};
      const responseConnectionHeaders = connectionHeaderNames(upstreamRes.headers.get('connection'));
      for (const [key, value] of upstreamRes.headers.entries()) {
        if (HOP_BY_HOP_HEADERS.has(key) || responseConnectionHeaders.has(key)) continue;
        if (key === CODEX_RECOVERY_SESSION_HEADER) continue;
        if (ctx.provider !== 'codex'
            && (key === 'content-encoding' || key === 'content-length')) continue;
        responseHeaders[key] = value;
      }
      if (logDir) {
        appendLogSection(`=== RESPONSE 400${modelUnsupported ? ' — codex model unsupported' : ''} ===\n${formatHeaders(upstreamRes.headers, metadataOnlyLog)}`);
        if (!metadataOnlyLog && !modelUnsupported) appendLogSection(formatLogBody('=== RESPONSE BODY', responseBody));
        flushRequestLog(logDir, reqId, logSections, hooks);
      }
      if (!res.headersSent) res.writeHead(400, responseHeaders);
      res.end(responseBody.length > 0 ? responseBody : undefined);
      return;
    }

    // Handle 429s. A 429 can mean two very different things:
    //   (a) this account is out of quota (account-level exhaustion), or
    //   (b) a transient / global / IP / request-level limit that would 429 on
    //       any account.
    // Only (a) should throttle the account and switch; replaying (b) across the
    // fleet would mark every account throttled and break unrelated requests.
    // isExhausted() (checked after updateQuota folds in the 429 headers)
    // distinguishes them.
    if (upstreamRes.status === 429) {
      let retryAfter = parseInt(upstreamRes.headers.get('retry-after'), 10);
      if (Number.isNaN(retryAfter)) retryAfter = 60;
      retryAfter = Math.min(Math.max(retryAfter, 1), 300); // clamp [1s, 5m]
      const responseBody = await readBodyBounded(
        upstreamRes.body,
        ctx.maxResponseBytes,
        ctx.reserveResponseBytes,
        ctx.releaseReservedResponseBytes,
      );
      if (responseBody === null) {
        ctx.status = 502;
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'proxy_error', message: 'Upstream 429 response exceeded the proxy limit.' },
          }));
        }
        return;
      }
      const responseHeaders = {};
      const responseConnectionHeaders = connectionHeaderNames(upstreamRes.headers.get('connection'));
      for (const [key, value] of upstreamRes.headers.entries()) {
        if (HOP_BY_HOP_HEADERS.has(key) || responseConnectionHeaders.has(key)) continue;
        if (key === CODEX_RECOVERY_SESSION_HEADER) continue;
        if (ctx.provider !== 'codex'
            && (key === 'content-encoding' || key === 'content-length')) continue;
        responseHeaders[key] = value;
      }
      if (responseHeaders['retry-after'] == null) {
        responseHeaders['retry-after'] = String(retryAfter);
      }
      ctx.last429 = { body: responseBody, headers: responseHeaders };

      if (staleAfterReset && !res.destroyed && retryCount < maxRetries) {
        console.log(`[TeamCodex] 429 on "${account.name}" was dispatched before its reset credit landed — ignoring it and retrying`);
        if (logDir) {
          appendLogSection(`=== RESPONSE 429 — dispatched before reset credit, retrying ===\n${formatHeaders(upstreamRes.headers, metadataOnlyLog)}`);
          flushRequestLog(logDir, reqId, logSections, hooks);
        }
        releaseHeld();
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
      }

      // A model-scoped exhaustion must only exclude this account for that model.
      // Globally throttling it would unnecessarily remove healthy Sonnet/Haiku
      // capacity for up to five minutes.
      if (accountManager.isModelExhausted(account, ctx.model)) {
        ctx.tried429.add(account);
        console.log(`[TeamClaude] 429 (model quota exhausted) on "${account.name}" — switching for ${ctx.model}`);
        if (!res.destroyed
            && (hasUsable(ctx.tried429) || hasCapped(ctx.tried429))) {
          releaseHeld();
          return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
        }
        releaseHeld();
        // Every account is out of quota for THIS model tier. Before waiting on
        // a (possibly days-away) weekly reset or surfacing a 429, walk the
        // configured fallback chain — a rewrite to a still-served model keeps
        // the client's turn alive.
        {
          const fallback = nextModelFallback(ctx, req, body);
          if (fallback && !res.destroyed) {
            logModelFallback(ctx, fallback, `fleet exhausted for ${ctx.model}`);
            ctx.model = fallback.model;
            ctx.tried429.clear();
            ctx.tried5xx.clear();
            return forwardRequest(req, res, fallback.body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
          }
        }
        // Continuity polls: each pass sleeps at most continuityMaxSleepMs and
        // retries. That is right for a 5h window, which really does clear while
        // we wait. A model-tier window is WEEKLY, so with no fallback configured
        // (the default `modelFallbacks: {}`) the same pass repeats until the week
        // rolls over: the client hangs for days and every sleep burns one real
        // upstream 429. Bound the polling; once the budget is spent the client
        // gets its 429 and can back off far more cheaply than we can.
        const deadlineMode = ctx.continuity.maxWaitMs > 0;
        const legacyWaitOpen = !deadlineMode
          && (ctx.modelWaitPasses || 0) < MODEL_EXHAUST_WAIT_PASSES;
        if (ctx.continuity.enabled && !res.destroyed && (deadlineMode || legacyWaitOpen)) {
          if (!deadlineMode) ctx.modelWaitPasses = (ctx.modelWaitPasses || 0) + 1;
          const wait = computeRetryAfter(
            accountManager.getStatus().accounts,
            accountManager.switchThreshold,
            ctx.model,
          );
          const deadlineAt = deadlineMode ? startContinuityDeadline(ctx) : null;
          const waited = await ctx.continuity.waitFor(wait, ctx.abortSignal, deadlineAt);
          if (ctx.abortSignal?.aborted || res.destroyed) return;
          if (!waited) {
            sendSaved429(res, ctx);
            return;
          }
          ctx.tried429.clear();
          return forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
        }
        ctx.status = 429;
        if (!res.headersSent) {
          res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(retryAfter) });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: `Model quota exhausted (retry in ${retryAfter}s).` },
          }));
        }
        return;
      }

      if (accountManager.isExhausted(account)) {
        // Account policy: redeem a reset credit on THIS account and retry it
        // here, before throttling/switching. (The fleet policy waits for the
        // acquisition dead end instead, so rotation to a healthy account wins.)
        // Once per account per request and only while the request's single
        // redemption pass is unspent (a fleet pass earlier in this request
        // already used it). The retry does NOT count toward maxRetries so a
        // second 429 still reaches the normal throttle → dead end →
        // Codex-native fail-fast body (never the legacy backstop).
        if (ctx.resetCredits?.policy === 'account' && !res.destroyed
            && ctx.resetCreditAttempts < 1
            && !ctx.resetCreditRetried.has(account)) {
          const attempt = await ctx.resetCredits.account(account, '429-exhausted', ctx.model);
          // Any outcome that may have spent a credit (reset, reset with no
          // windows, timeout/5xx) IS the request's single pass: the dead end
          // that follows must fail fast, not walk the pool spending again.
          if (attempt.kind !== 'no-spend') ctx.resetCreditAttempts = Math.max(ctx.resetCreditAttempts, 1);
          if (attempt.reset) {
            ctx.resetCreditRetried.add(account);
            if (res.destroyed) return;
            if (logDir) {
              appendLogSection(`=== RESPONSE 429 — account quota exhausted, reset credit redeemed, retrying same account ===\n${formatHeaders(upstreamRes.headers, metadataOnlyLog)}`);
              flushRequestLog(logDir, reqId, logSections, hooks);
            }
            releaseHeld();
            return forwardRequest(req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir);
          }
        }
        // (a) Account-level exhaustion: throttle this account (so
        // getActiveAccount skips it until it resets) and immediately
        // re-dispatch to another available account — never sleep holding the
        // client. When every account is throttled, getActiveAccount returns
        // null and the client gets a 429 to back off on its own.
        console.log(`[TeamClaude] 429 (quota exhausted) on "${account.name}" — throttling ${retryAfter}s, switching accounts`);
        accountManager.markRateLimited(account, retryAfter);
        if (logDir) {
          appendLogSection(`=== RESPONSE 429 — account quota exhausted, throttled ${retryAfter}s, switching ===\n${formatHeaders(upstreamRes.headers, metadataOnlyLog)}`);
          flushRequestLog(logDir, reqId, logSections, hooks);
        }
        if (res.destroyed) return;

        // Safety backstop: each retry throttles a distinct account, so
        // getActiveAccount returns null before this can fire. Cap anyway.
        if (retryCount >= maxRetries) {
          ctx.status = 429;
          const ra = computeRetryAfter(accountManager.getStatus().accounts, accountManager.switchThreshold, ctx.model);
          if (!res.headersSent) {
            res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(ra) });
            res.end(JSON.stringify({
              type: 'error',
              error: { type: 'rate_limit_error', message: `All accounts throttled. Retry in ${ra}s.` },
            }));
          }
          return;
        }
        releaseHeld(); // throttled this account; switch to another
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
      }

      // (b) Non-exhaustion 429: usually an account-level request-rate /
      // concurrency limit (the account still has token quota, but is being hit
      // too fast) — or a transient / global limit. Try ANOTHER account for THIS
      // request (per-request exclusion via ctx.tried429) so concurrent overflow
      // spreads to an idle account instead of failing. Crucially we do NOT
      // throttle the account: throttling on a request-global 429 would poison
      // the fleet for unrelated requests. The configured failover budget bounds
      // this replay before continuity handling or passthrough; no account
      // state is mutated either way. A complete 429 rejection is replayable
      // even for POST because upstream completed the rejection.
      ctx.tried429.add(account);
      const failoverLimit = ctx.continuity.rateLimitFailovers;
      if (!res.destroyed && retryCount < maxRetries && ctx.tried429.size <= failoverLimit
          && (hasUsable(ctx.tried429) || hasCapped(ctx.tried429))) {
        console.log(`[TeamClaude] 429 (rate/transient) on "${account.name}" — switching account for this request`);
        if (logDir) {
          appendLogSection(`=== RESPONSE 429 — rate/transient, switching account (not throttled) ===\n${formatHeaders(upstreamRes.headers, metadataOnlyLog)}`);
          flushRequestLog(logDir, reqId, logSections, hooks);
        }
        releaseHeld(); // free this account's slot before trying another
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
      }

      const maxOverload = Math.max(0, envInt('TEAMCLAUDE_OVERLOAD_RETRIES', 6));
      const deadlineMode = ctx.continuity.enabled && ctx.continuity.maxWaitMs > 0;
      const deadlineAt = deadlineMode ? startContinuityDeadline(ctx) : null;
      const deadlineOpen = deadlineMode && Date.now() < deadlineAt;
      const legacyRetryOpen = !deadlineMode && ctx.overloadRetries < maxOverload;
      if (ctx.continuity.enabled && !res.destroyed && (deadlineOpen || legacyRetryOpen)) {
        const backoffBase = Math.max(50, envInt('TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS', 1000));
        const backoffCap = Math.max(backoffBase, envInt('TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS', 10000));
        const exponentialBackoff = Math.min(
          backoffBase * 2 ** Math.min(ctx.overloadRetries, 30),
          backoffCap,
        );
        const waitMs = Math.max(retryAfter * 1000, exponentialBackoff);
        ctx.overloadRetries += 1;
        const retryBudget = deadlineMode
          ? `${Math.max(0, deadlineAt - Date.now())}ms remaining`
          : `${ctx.overloadRetries}/${maxOverload}`;
        console.log(`[TeamClaude] 429 (global) on "${account.name}" — cooling down internally (${retryBudget})`);
        releaseHeld();
        ctx.continuity.deferMs(waitMs);
        const waited = await ctx.continuity.waitGlobal(ctx.abortSignal, ctx);
        if (ctx.abortSignal?.aborted || res.destroyed) return;
        if (waited) {
          ctx.tried429.clear();
          ctx.tried5xx.clear();
          return forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
        }
      }

      console.log(`[TeamClaude] 429 (global) on "${account.name}" — failover budget exhausted, passing through`);
      ctx.status = 429;
      if (logDir) {
        appendLogSection(`=== RESPONSE 429 — global, passed through after exhausting failover budget ===\n${formatHeaders(upstreamRes.headers, metadataOnlyLog)}`);
        flushRequestLog(logDir, reqId, logSections, hooks);
      }
      if (sendSaved429(res, ctx)) return;
      if (res.destroyed) return;
      if (!res.headersSent) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': String(retryAfter) });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'rate_limit_error', message: `Upstream rate limited (retry in ${retryAfter}s).` },
        }));
      }
      return;
    }

    // Handle retryable upstream 5xx (notably 529 "Overloaded" — Anthropic is over
    // capacity). Unlike a 429, a 529 is NOT account-specific: every account hits
    // the same overloaded upstream. Surfacing it fails the client's turn, so:
    //   (1) fail this request over to another account (cheap; for 500/502/503/504 a
    //       different account/region is occasionally healthier), then
    //   (2) once every account has 5xx'd for this request, wait a bounded
    //       exponential backoff and retry the whole fleet — the client transparently
    //       gets the eventual success instead of an error.
    // Outside continuity mode the configured backoff budget bounds the wait.
    // In continuity mode the client explicitly chose continuity over fail-fast:
    // keep the request inside the proxy until upstream recovers or the client
    // disconnects. No account state is mutated — a 529 is upstream overload,
    // not a bad account.
    if (RETRYABLE_STATUS.has(upstreamRes.status)) {
      const code = upstreamRes.status;
      await upstreamRes.body?.cancel();

      // A 5xx only proves the response failed, not that the upstream skipped
      // the request. Replaying a POST here can duplicate inference, tool side
      // effects, and billing. Complete 503/507 responses are still ambiguous:
      // the provider may have accepted the request before the error surfaced.
      // Only exact-session TUI continuation may recover an unsafe POST.
      if (!replaySafe) {
        console.log(`[TeamClaude] ${code} after ${method} dispatch on "${account.name}" — passing through without replay`);
        ctx.status = code;
        if (logDir) {
          appendLogSection(`=== RESPONSE ${code} — unsafe request was not replayed ===\n${formatHeaders(upstreamRes.headers, metadataOnlyLog)}`);
          flushRequestLog(logDir, reqId, logSections, hooks);
        }
        if (!res.destroyed && !res.headersSent) {
          const responseHeaders = codexRecoveryResponseHeaders(
            req,
            body,
            ctx,
            method,
            { 'Content-Type': 'application/json' },
          );
          res.writeHead(code, responseHeaders);
          res.end(JSON.stringify({
            type: 'error',
            error: {
              type: 'overloaded_error',
              message: `Upstream overloaded (HTTP ${code}). Request was not replayed.`,
            },
          }));
        }
        return;
      }

      const maxOverload = Math.max(0, envInt('TEAMCLAUDE_OVERLOAD_RETRIES', 6));
      const backoffBase = Math.max(50, envInt('TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS', 1000));
      const backoffCap = Math.max(backoffBase, envInt('TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS', 10000));

      // (1) Per-request failover to an account not yet 5xx'd (or 429'd) this
      // request.
      ctx.tried5xx.add(account);
      const exclude5xx = new Set([...ctx.tried429, ...ctx.tried5xx]);
      if (!res.destroyed && retryCount < maxRetries
          && (hasUsable(exclude5xx) || hasCapped(exclude5xx))) {
        console.log(`[TeamClaude] ${code} on "${account.name}" — switching account for this request`);
        if (logDir) {
          appendLogSection(`=== RESPONSE ${code} — transient upstream 5xx, switching account ===\n${formatHeaders(upstreamRes.headers, metadataOnlyLog)}`);
          flushRequestLog(logDir, reqId, logSections, hooks);
        }
        releaseHeld(); // free this account's slot before trying another
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
      }

      // (2) Every account 5xx'd for this request → upstream overload. Back off and
      // retry the whole fleet so the client transparently rides out the blip.
      const overloadRetryOpen = ctx.overloadRetries < maxOverload;
      if (!res.destroyed && overloadRetryOpen) {
        const retryAfterMs = parseRetryAfterMs(upstreamRes.headers.get('retry-after'));
        const backoffMs = Math.min(
          backoffBase * 2 ** Math.min(ctx.overloadRetries, 30),
          backoffCap,
        );
        const waitMs = Math.max(retryAfterMs, backoffMs);
        ctx.overloadRetries += 1;
        const retryBudget = `${ctx.overloadRetries}/${maxOverload}`;
        console.log(`[TeamClaude] ${code} on every account — upstream overloaded, backing off ${waitMs}ms (retry ${ctx.overloadRetries}, ${retryBudget})`);
        if (logDir) {
          appendLogSection(`=== RESPONSE ${code} — all accounts overloaded, backoff ${waitMs}ms (retry ${ctx.overloadRetries}, ${retryBudget}) ===`);
          flushRequestLog(logDir, reqId, logSections, hooks);
        }
        await sleepOrAbort(waitMs, ctx.abortSignal);
        if (res.destroyed || ctx.abortSignal?.aborted) return;
        ctx.tried5xx.clear();
        releaseHeld();
        return forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
      }

      // (3) Backoff budget spent — surface the 5xx rather than hold the client forever.
      console.log(`[TeamClaude] ${code} on "${account.name}" — overload persisted after ${ctx.overloadRetries} backoffs, passing through`);
      ctx.status = code;
      if (logDir) {
        appendLogSection(`=== RESPONSE ${code} — overload persisted after ${ctx.overloadRetries} backoffs, passed through ===\n${formatHeaders(upstreamRes.headers, metadataOnlyLog)}`);
        flushRequestLog(logDir, reqId, logSections, hooks);
      }
      if (res.destroyed) return;
      if (!res.headersSent) {
        res.writeHead(code, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: `Upstream overloaded (HTTP ${code}). Retried ${ctx.overloadRetries}x.` },
        }));
      }
      return;
    }

    // Log response headers
    if (logDir) {
      appendLogSection(`=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers, metadataOnlyLog)}`);
    }

    ctx.status = upstreamRes.status;

    if (ctx.provider === 'codex' && upstreamRes.status >= 200 && upstreamRes.status < 300) {
      accountManager.clearModelUnsupported(account, ctx.model);
    }

    // A 2xx on this account is live upstream proof its subscription serves
    // again — clear the persistent lapse flag (memory + config). Guarded on
    // the flag so the common path never touches account or config state.
    if (account.subscriptionDisabled && upstreamRes.status >= 200 && upstreamRes.status < 300) {
      console.log(`[TeamClaude] 2xx on "${account.name}" — clearing subscription-disabled flag`);
      accountManager.setSubscriptionDisabled(account, false);
    }

    const responseHeaders = {};
    const responseConnectionHeaders = connectionHeaderNames(upstreamRes.headers.get('connection'));
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (HOP_BY_HOP_HEADERS.has(key) || responseConnectionHeaders.has(key)) continue;
      if (key === CODEX_RECOVERY_SESSION_HEADER) continue;
      if (ctx.provider !== 'codex'
          && (key === 'content-encoding' || key === 'content-length')) continue;
      responseHeaders[key] = value;
    }

    // Same predicate the supervisor relay uses (index.js). These two must agree:
    // the supervisor only frames what the worker framed, so a local copy that
    // drifts would silently break recovery on whatever the two classify differently.
    if (isStreaming && upstreamRes.body) {
      const parseStreamUsage = ctx.provider !== 'codex'
        || !String(upstreamRes.headers.get('content-encoding') || '')
          .split(',')
          .some(encoding => encoding.trim() && encoding.trim().toLowerCase() !== 'identity');
      const streamLog = logDir && !metadataOnlyLog
        ? {
            chunks: [],
            bytes: 0,
            truncated: false,
            maxBytes: ctx.maxResponseBytes,
            reserveBytes: ctx.reserveAuxiliaryResponseBytes,
            releaseBytes: ctx.releaseAuxiliaryResponseBytes,
          }
        : null;
      // With recovery on, response headers are DEFERRED until the first whole
      // SSE frame arrives: an upstream that dies before producing anything
      // leaves the client response untouched and fully replayable on another
      // account — a transparent failover beats asking the client to retry.
      const ensureHeaders = () => {
        if (!res.headersSent) res.writeHead(upstreamRes.status, responseHeaders);
      };
      if (!ctx.streamRecovery) ensureHeaders(); // legacy: headers first, bytes as they come
      const outcome = await streamResponse(
        upstreamRes.body,
        res,
        account,
        accountManager,
        streamLog,
        ctx.streamRecovery,
        ctx.streamRecovery && ctx.continuity.enabled,
        ensureHeaders,
        ctx.maxResponseBytes,
        ctx.streamIdleTimeoutMs,
        ctx.streamTotalTimeoutMs,
        ctx.reserveResponseBytes,
        ctx.reserveAuxiliaryResponseBytes,
        ctx.releaseAuxiliaryResponseBytes,
        parseStreamUsage,
        upstreamRes.headers.get('content-encoding'),
      );
      if (outcome.limitExceeded && !res.headersSent && !res.destroyed) {
        ctx.status = 502;
        res.writeHead(502, codexRecoveryResponseHeaders(
          req,
          body,
          ctx,
          method,
          { 'Content-Type': 'application/json' },
        ));
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'proxy_error',
            message: `Upstream stream exceeded the ${ctx.maxResponseBytes}-byte response limit.`,
          },
        }));
        return;
      }
      if (outcome.preStreamFailure && !res.headersSent && !res.destroyed) {
        // Nothing reached the client, but upstream may already have accepted
        // the request. Only replay-safe methods can move to another account;
        // an unsafe POST is surfaced as a retryable error for the client to
        // decide, avoiding a hidden duplicate execution inside the proxy.
        if (!replaySafe) {
          console.log(`[TeamClaude] Upstream stream ${outcome.preStreamFailure} after ${method} dispatch on "${account.name}" — not replaying`);
          if (logDir) {
            appendLogSection(`=== STREAM ${outcome.preStreamFailure} — unsafe request was not replayed ===`);
            flushRequestLog(logDir, reqId, logSections, hooks);
          }
          ctx.status = 529;
          res.writeHead(529, codexRecoveryResponseHeaders(
            req,
            body,
            ctx,
            method,
            { 'Content-Type': 'application/json', 'retry-after': '5' },
          ));
          res.end(JSON.stringify({
            type: 'error',
            error: {
              type: 'overloaded_error',
              message: 'Upstream stream failed after dispatch. Request was not replayed; please retry.',
            },
          }));
          return;
        }

        console.log(`[TeamClaude] Upstream stream ${outcome.preStreamFailure} before any data on "${account.name}" — replaying on another account`);
        if (logDir) {
          appendLogSection(`=== STREAM ${outcome.preStreamFailure} before any data — replaying ===`);
          flushRequestLog(logDir, reqId, logSections, hooks);
        }
        ctx.tried5xx.add(account);
        const excludeStream = new Set([...ctx.tried429, ...ctx.tried5xx]);
        if (retryCount < maxRetries
            && (hasUsable(excludeStream) || hasCapped(excludeStream))) {
          releaseHeld();
          return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
        }
        const maxOverload = Math.max(0, envInt('TEAMCLAUDE_OVERLOAD_RETRIES', 6));
        if (ctx.continuity.enabled && ctx.overloadRetries < maxOverload) {
          const backoffBase = Math.max(50, envInt('TEAMCLAUDE_OVERLOAD_BACKOFF_BASE_MS', 1000));
          const backoffCap = Math.max(backoffBase, envInt('TEAMCLAUDE_OVERLOAD_BACKOFF_CAP_MS', 10000));
          const waitMs = Math.min(
            backoffBase * 2 ** Math.min(ctx.overloadRetries, 30),
            backoffCap,
          );
          ctx.overloadRetries += 1;
          console.log(`[TeamClaude] Upstream stream failed on every account — backing off ${waitMs}ms (retry ${ctx.overloadRetries}/${maxOverload})`);
          releaseHeld();
          await sleepOrAbort(waitMs, ctx.abortSignal);
          if (res.destroyed || ctx.abortSignal?.aborted) return;
          ctx.tried5xx.clear();
          return forwardRequest(req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir);
        }
        ctx.status = 529;
        res.writeHead(529, { 'Content-Type': 'application/json', 'retry-after': '5' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'Upstream stream failed before any data. Please retry.' },
        }));
        return;
      }
      if (outcome.injected) {
        // NOT an account failure: the response was already partially delivered,
        // so the only recovery that helps is the CLIENT retrying — which the
        // injected error event triggers. No account state is mutated.
        console.log(`[TeamClaude] Upstream stream ${outcome.reason} on "${account.name}" — appended retryable error event for client-side retry`);
      }
      if (ctx.provider === 'codex' && isCodexInferenceRequest(req)
          && upstreamRes.status >= 200 && upstreamRes.status < 300
          && outcome.responseCompleted) {
        accountManager.markAccountSuccess(account);
        await accountManager.waitForAccountFlag(account).catch(err => {
          console.error(`[TeamClaude] Failed to persist subscription recovery for "${account.name}": ${err.message}`);
        });
      }
      if (streamLog) {
        const truncation = streamLog.truncated
          ? `\n[stream log truncated at ${streamLog.maxBytes} bytes]`
          : '';
        const heading = `=== RESPONSE BODY (streamed${outcome.injected ? `; ${outcome.reason} → injected retryable error event` : ''}) ===`;
        await writeStreamRequestLog(logDir, reqId, logSections, heading, streamLog, truncation, hooks);
        streamLog.releaseBytes(streamLog.bytes);
        streamLog.bytes = 0;
        streamLog.chunks.length = 0;
      } else if (logDir) {
        flushRequestLog(logDir, reqId, logSections, hooks);
      }
    } else {
      // Buffer non-SSE bodies before sending headers so replay-safe methods can
      // recover from body-read failures and oversized upstream responses can be
      // rejected cleanly without exposing partial attacker-controlled bytes.
      const buf = await readBodyBounded(
        upstreamRes.body,
        ctx.maxResponseBytes,
        ctx.reserveResponseBytes,
        ctx.releaseReservedResponseBytes,
      );
      if (buf === null) {
        ctx.status = 502;
        res.writeHead(502, codexRecoveryResponseHeaders(
          req,
          body,
          ctx,
          method,
          { 'Content-Type': 'application/json' },
        ));
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'proxy_error', message: 'Upstream response exceeded the proxy limit.' },
        }));
        return;
      }
      let responseCompleted = false;
      if (ctx.provider === 'codex' && upstreamRes.headers.get('content-encoding')) {
        if (ctx.reserveAuxiliaryResponseBytes(CODEX_ERROR_INSPECTION_MAX_BYTES)) {
          try {
            const inspectionBody = decodeBodyForInspection(
              buf,
              upstreamRes.headers.get('content-encoding'),
              CODEX_ERROR_INSPECTION_MAX_BYTES,
            );
            if (inspectionBody != null) {
              extractUsageFromBody(inspectionBody, account, accountManager);
              responseCompleted = isCompletedCodexResponse(inspectionBody);
            }
          } finally {
            ctx.releaseAuxiliaryResponseBytes(CODEX_ERROR_INSPECTION_MAX_BYTES);
          }
        }
      } else {
        extractUsageFromBody(buf, account, accountManager);
        responseCompleted = isCompletedCodexResponse(buf);
      }
      if (ctx.provider === 'codex' && isCodexInferenceRequest(req)
          && upstreamRes.status >= 200 && upstreamRes.status < 300
          && responseCompleted) {
        accountManager.markAccountSuccess(account);
        await accountManager.waitForAccountFlag(account).catch(err => {
          console.error(`[TeamClaude] Failed to persist subscription recovery for "${account.name}": ${err.message}`);
        });
      }
      if (logDir && !metadataOnlyLog) {
        appendLogSection(formatLogBody('=== RESPONSE BODY', buf));
        flushRequestLog(logDir, reqId, logSections, hooks);
      } else if (logDir) {
        flushRequestLog(logDir, reqId, logSections, hooks);
      }
      if (!res.headersSent) res.writeHead(upstreamRes.status, responseHeaders);
      res.end(buf.length ? buf : undefined);
    }
  } catch (err) {
    if (upstreamDeadline.timedOut && !res.destroyed) {
      if (continuityBoundedTimeout && replaySafe && sendSaved429(res, ctx)) return;
      console.error(`[TeamClaude] Upstream response timed out on account "${account.name}"`);
      if (logDir) {
        appendLogSection('=== ERROR ===\nUpstream response timed out.');
        flushRequestLog(logDir, reqId, logSections, hooks);
      }

      ctx.tried5xx.add(account);
      if (!continuityBoundedTimeout && replaySafe && retryCount < maxRetries
          && (accountManager.anyUsable(ctx.tried5xx, ctx.model)
            || accountManager.anyCapped(ctx.tried5xx, ctx.model))) {
        console.log(`[TeamClaude] Response timeout on "${account.name}" — switching account for this request`);
        releaseHeld();
        return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
      }

      sendUpstreamTimeout(res, ctx, codexRecoveryResponseHeaders(
        req,
        body,
        ctx,
        method,
        { 'Content-Type': 'application/json' },
      ));
      return;
    }

    // Client disconnected → we aborted the upstream fetch (ctx.abortSignal). This
    // is not the account's fault: don't mark it 'error' or fail over (the client
    // is gone). Just unwind — the outer finally releases the slot / inFlightProxied.
    if (ctx.abortSignal?.aborted || err?.name === 'AbortError' || err?.code === 'ABORT_ERR' || res.destroyed) {
      if (!res.writableEnded) res.destroy();
      return;
    }

    console.error(`[TeamClaude] Upstream error (account "${account.name}"):`, err.message);

    if (logDir) {
      appendLogSection(metadataOnlyLog
        ? '=== ERROR ===\nUpstream request failed.'
        : `=== ERROR ===\n${err.stack || err.message}`);
      flushRequestLog(logDir, reqId, logSections, hooks);
    }

    // Undici surfaces a connection that dies WHILE READING THE BODY differently
    // from one that dies at dispatch: `TypeError: terminated` with the socket
    // error as `cause` (code UND_ERR_SOCKET/ECONNRESET), not a top-level code.
    // Buffered non-SSE bodies also reach this path; the method gate below
    // decides whether transport recovery is safe without poisoning the account.
    const TRANSIENT_CODES = new Set([
      'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET',
    ]);
    const isTransient = err instanceof Error &&
      (err.message.includes('fetch failed') ||
        err.message.includes('terminated') ||
        TRANSIENT_CODES.has(err.code) ||
        TRANSIENT_CODES.has(err.cause?.code));

    // Transient network errors are ambiguous once dispatch starts: upstream may
    // have accepted an unsafe request even when no response reached us. Keep
    // account-local failover for replay-safe methods only. A network blip does
    // not poison the account; exclusion remains per-request via tried5xx.
    if (isTransient) {
      if (replaySafe && !res.headersSent && !res.destroyed && retryCount < maxRetries) {
        ctx.tried5xx.add(account);
        if (accountManager.anyUsable(ctx.tried5xx, ctx.model)
          || accountManager.anyCapped(ctx.tried5xx, ctx.model)) {
          console.log(`[TeamClaude] Network error on "${account.name}" — switching account for this request`);
          releaseHeld();
          return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
        }
      }
      if (!replaySafe && !res.headersSent && !res.destroyed) {
        ctx.status = 502;
        const responseHeaders = codexRecoveryResponseHeaders(
          req,
          body,
          ctx,
          method,
          { 'Content-Type': 'application/json' },
        );
        res.writeHead(502, responseHeaders);
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'proxy_error',
            message: 'Upstream connection failed after dispatch. Request was not replayed.',
          },
        }));
      } else if (!res.writableEnded) {
        // Legacy/codex mid-stream: only destroy a genuinely unfinished
        // response; destroying after streamResponse ended it can discard tail.
        res.destroy();
      }
      return;
    }

    if (replaySafe && retryCount < maxRetries && !res.headersSent) {
      // Preserve a prior refresh-failure label, but label a new request-path
      // send failure so a later token rotation cannot blindly revive it.
      if (account.status !== 'error') {
        account._errorFromRefresh = false;
        account.errorReason = 'send-failed';
      }
      account.status = 'error';
      account.errorReason = 'send-failed';
      releaseHeld(); // this account errored; fail over to another
      return forwardRequest(req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir);
    }
    ctx.status = 502;

    if (!res.headersSent) {
      res.writeHead(502, codexRecoveryResponseHeaders(
        req,
        body,
        ctx,
        method,
        { 'Content-Type': 'application/json' },
      ));
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'proxy_error', message: `Upstream error: ${err.message}` },
      }));
    }
  } finally {
    upstreamDeadline.dispose();
    if (!logSections.flushing) logSections.release();
  }
}

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 *
 * With `recover` (anthropic mode, `config.streamRecovery !== false`) the stream
 * is parsed one WHOLE SSE event at a time (SseFramer). With `transactional`
 * (continuity mode) no event is exposed until a terminal event arrives; an
 * abnormal attempt is discarded and returned without leaking partial output.
 * The caller may replay only a replay-safe method; unsafe requests are surfaced
 * for the client to decide. Outside continuity mode, an abnormal end keeps the
 * legacy recovery contract: append a synthetic retryable `overloaded_error`
 * event and let the client retry.
 *
 * With recovery, `ensureHeaders` defers the client's response headers until the
 * first whole frame is forwarded; a failure BEFORE that point returns
 * { preStreamFailure } with the response untouched, so the caller can either
 * replay a safe method or surface an unsafe request without partial output.
 *
 * Returns { injected, reason, preStreamFailure }.
 */
async function streamResponse(
  webStream,
  res,
  account,
  accountManager,
  streamLog,
  recover = false,
  transactional = false,
  ensureHeaders = null,
  transactionMaxBytes = DEFAULT_MAX_RESPONSE_BYTES,
  streamIdleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  streamTotalTimeoutMs = null,
  reserveResponseBytes = () => true,
  reserveAuxiliaryResponseBytes = () => true,
  releaseAuxiliaryResponseBytes = () => {},
  parseUsage = true,
  contentEncoding = null,
) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let sseBufferBytes = 0;
  let usageBufferDisabled = !parseUsage;
  const framer = recover && parseUsage
    ? new SseFramer({
        reserveBytes: reserveAuxiliaryResponseBytes,
        releaseBytes: releaseAuxiliaryResponseBytes,
    })
    : null;
  const terminalObserver = framer || (parseUsage ? new SseFramer() : null);
  const encodedTerminalObserver = parseUsage
    ? null
    : createEncodedSseObserver(
        contentEncoding,
        reserveAuxiliaryResponseBytes,
        releaseAuxiliaryResponseBytes,
      );
  const bufferedFrames = transactional ? [] : null;
  let bufferedBytes = 0;
  let spillFile = null;
  let spillPath = null;
  let spillUnlinked = false;
  let endedNormally = false;
  const streamDeadlineAt = Number.isFinite(streamTotalTimeoutMs)
    ? Date.now() + streamTotalTimeoutMs
    : Infinity;
  const outcome = {
    injected: false,
    reason: null,
    preStreamFailure: null,
    limitExceeded: false,
    completed: false,
    responseCompleted: false,
  };

  // Append a well-formed retryable error frame and end. Only called when every
  // byte written so far ended at an event boundary (the framer guarantees it),
  // so the client's SSE parser sees a clean error event, never half a payload.
  const endWithRetryableError = (reason) => {
    outcome.injected = true;
    outcome.reason = reason;
    res.end(sseErrorEvent(
      `TeamClaude: upstream stream ${reason}; the response is incomplete — please retry.`));
  };

  // Forward bytes + fold their text into logging/usage parsing. Returns
  // res.write()'s backpressure verdict.
  const forwardChunk = (bytes) => {
    ensureHeaders?.(); // first whole frame is ready — commit the deferred headers
    const ok = res.write(bytes);
    if (streamLog && !streamLog.truncated) {
      const remaining = streamLog.maxBytes - streamLog.bytes;
      const logged = bytes.length <= remaining ? bytes : bytes.subarray(0, remaining);
      if (logged.length > 0) {
        if (streamLog.reserveBytes(logged.length)) {
          streamLog.chunks.push(Buffer.from(logged));
          streamLog.bytes += logged.length;
        } else {
          streamLog.truncated = true;
        }
      }
      if (logged.length < bytes.length) streamLog.truncated = true;
    }
    if (!usageBufferDisabled) {
      if (!reserveAuxiliaryResponseBytes(bytes.length)) {
        releaseAuxiliaryResponseBytes(sseBufferBytes);
        sseBuffer = '';
        sseBufferBytes = 0;
        usageBufferDisabled = true;
      } else {
        sseBufferBytes += bytes.length;
        const text = decoder.decode(bytes, { stream: true });
        sseBuffer += text;
        const events = sseBuffer.split('\n\n');
        sseBuffer = events.pop(); // keep incomplete event
        const retainedBytes = Buffer.byteLength(sseBuffer);
        releaseAuxiliaryResponseBytes(sseBufferBytes - retainedBytes);
        sseBufferBytes = retainedBytes;
        // Usage parsing is best-effort: a "partial event" that grows this large is
        // a giant content delta or a CRLF-only stream — nothing parseSSEUsage could
        // read either way. Drop it instead of buffering without bound.
        if (sseBuffer.length > 1_048_576) {
          releaseAuxiliaryResponseBytes(sseBufferBytes);
          sseBuffer = '';
          sseBufferBytes = 0;
          usageBufferDisabled = true;
        }
        for (const event of events) {
          parseSSEUsage(event, account, accountManager);
        }
      }
    }
    return ok;
  };

  const waitForDrain = async () => {
    if (res.destroyed || res.writableEnded) return false;
    return new Promise(resolve => {
      let timer = null;
      const settle = (drained) => {
        res.removeListener('drain', onDrain);
        res.removeListener('close', onClose);
        if (timer !== null) clearTimeout(timer);
        if (!drained && !res.destroyed) res.destroy();
        resolve(drained);
      };
      const onDrain = () => settle(true);
      const onClose = () => settle(false);
      res.once('drain', onDrain);
      res.once('close', onClose);
      const remainingTotalMs = Math.max(1, streamDeadlineAt - Date.now());
      timer = setTimeout(
        () => settle(false),
        Math.min(streamIdleTimeoutMs, remainingTotalMs),
      );
      timer.unref?.();
    });
  };

  const writeSpill = async (bytes) => {
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await spillFile.write(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (bytesWritten === 0) throw new Error('Unable to buffer upstream stream');
      offset += bytesWritten;
    }
  };

  const stageChunk = async (bytes, auxiliaryReservationBytes = 0) => {
    if (bufferedBytes + bytes.length > transactionMaxBytes) {
      outcome.limitExceeded = true;
      return false;
    }
    const reservationBytes = auxiliaryReservationBytes || bytes.length;
    if (!reserveResponseBytes(reservationBytes)) {
      outcome.limitExceeded = true;
      return false;
    }
    if (auxiliaryReservationBytes > 0) {
      framer.releaseForwarded(auxiliaryReservationBytes, false);
      releaseAuxiliaryResponseBytes(auxiliaryReservationBytes);
    }
    if (!spillFile && bufferedBytes + bytes.length > TRANSACTION_MEMORY_BYTES) {
      spillPath = join(tmpdir(), `teamclaude-stream-${process.pid}-${randomUUID()}.tmp`);
      spillFile = await open(spillPath, 'wx+', 0o600);
      try {
        await unlink(spillPath);
        spillUnlinked = true;
      } catch {}
      for (const frame of bufferedFrames) await writeSpill(frame);
      bufferedFrames.length = 0;
    }
    if (spillFile) await writeSpill(bytes);
    else bufferedFrames.push(bytes);
    bufferedBytes += bytes.length;
    return true;
  };

  const relayChunk = async (bytes) => {
    if (transactional) {
      return stageChunk(bytes, framer?.forwardedReservationBytes || 0);
    }
    if (!forwardChunk(bytes) && !await waitForDrain()) return false;
    return !res.destroyed;
  };

  const flushTransaction = async () => {
    if (spillFile) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (position < bufferedBytes) {
        if (res.destroyed || res.writableEnded) return false;
        const { bytesRead } = await spillFile.read(
          chunk,
          0,
          Math.min(chunk.length, bufferedBytes - position),
          position,
        );
        if (bytesRead === 0) throw new Error('Unable to replay buffered upstream stream');
        position += bytesRead;
        if (!forwardChunk(chunk.subarray(0, bytesRead)) && !await waitForDrain()) return false;
      }
    } else {
      for (const bytes of bufferedFrames) {
        if (res.destroyed || res.writableEnded) return false;
        if (!forwardChunk(bytes) && !await waitForDrain()) return false;
      }
    }
    return !res.destroyed;
  };

  try {
    while (true) {
      let step;
      try {
        const remainingTotalMs = streamDeadlineAt - Date.now();
        const totalDeadlineIsSooner = remainingTotalMs <= streamIdleTimeoutMs;
        step = await raceTimeout(
          reader.read(),
          Math.max(1, Math.min(streamIdleTimeoutMs, remainingTotalMs)),
          totalDeadlineIsSooner
            ? `Upstream SSE total timeout after ${streamTotalTimeoutMs}ms`
            : `Upstream SSE idle timeout after ${streamIdleTimeoutMs}ms`,
        );
      } catch (err) {
        // Upstream died mid-stream.
        if (framer && !res.destroyed && !res.writableEnded) {
          const detail = err?.cause?.code || err?.code || err?.name || 'network error';
          if (transactional && !framer.sawTerminal) {
            // No semantic bytes from this attempt reached the client. Discard
            // every staged frame and let the caller apply the method-safety gate.
            outcome.preStreamFailure = `errored (${detail})`;
            return outcome;
          }
          if (!res.headersSent) {
            // Nothing was forwarded yet (headers still deferred): hand the
            // method-aware replay decision back to the caller.
            outcome.preStreamFailure = `errored (${detail})`;
            return outcome;
          }
          if (!framer.sawTerminal && !framer.passthrough) {
            // Events are already out, so another account cannot help THIS
            // response — but a clean retryable error event keeps the client's
            // automatic retry alive, where a destroyed socket fails the turn.
            endWithRetryableError(`errored mid-response (${detail})`);
            return outcome;
          }
          // Terminal already delivered — close out normally. Or framing
          // degraded to passthrough (oversized frame): an injection could land
          // mid-event and corrupt the parse, so end plainly like legacy.
          break;
        }
        if (framer) break; // client gone — nothing left to salvage
        throw err; // legacy mode: caller decides (destroys the client socket)
      }
      if (step.done) {
        endedNormally = true;
        break;
      }

      // Client disconnected — stop reading from upstream
      if (res.destroyed) break;

      const bytes = framer ? framer.push(step.value) : step.value;
      if (framer?.limitExceeded) {
        outcome.limitExceeded = true;
        break;
      }
      if (!framer) {
        if (encodedTerminalObserver) await encodedTerminalObserver.push(step.value);
        else terminalObserver?.push(step.value);
      }
      if (!bytes || bytes.length === 0) continue; // partial frame still buffering

      // Handle backpressure — also bail out if client disconnects,
      // because 'drain' will never fire on a destroyed socket. Both listeners
      // are removed once either fires, so a long stream with many backpressure
      // pauses doesn't accumulate dead 'close' listeners.
      const relayed = await relayChunk(bytes);
      if (!transactional) framer?.releaseForwarded(bytes.length);
      if (!relayed) break;
    }

    if (outcome.limitExceeded) return outcome;

    // Parse any remaining (partial / never-forwarded) text for usage tracking
    if (sseBuffer.trim()) {
      parseSSEUsage(sseBuffer, account, accountManager);
    }

    if (framer && !res.destroyed && !res.writableEnded) {
      if (framer.sawTerminal) {
        // Complete stream — flush any trailing bytes after the terminal event
        // (comments / blank lines) for byte fidelity; finally ends normally.
        if (framer.pending.length) {
          const pending = framer.takePending();
          if (transactional) {
            if (!await stageChunk(pending, pending.length)) return outcome;
          } else {
            res.write(pending);
            framer.releaseForwarded(pending.length);
          }
        }
        if (transactional) await flushTransaction();
      } else if (transactional) {
        // Frames may have been staged, but none were exposed. Treat a clean
        // socket close without a terminal event exactly like a read error.
        outcome.preStreamFailure = 'ended without a terminal event';
        return outcome;
      } else if (!res.headersSent) {
        // Ended before a single whole frame: fully replayable by the caller.
        outcome.preStreamFailure = 'ended without data';
        return outcome;
      } else if (!framer.passthrough) {
        // The upstream ended without message_stop/error: a silently truncated
        // response. The partial frame (if any) was never forwarded, so the
        // injected error lands on a clean event boundary.
        endWithRetryableError('ended mid-response without a terminal event');
        return outcome;
      }
      // else: framing degraded to passthrough — the last relayed bytes may sit
      // mid-event, where an injected frame would corrupt the parse. End plainly.
    }
    await encodedTerminalObserver?.finish();
    outcome.completed = endedNormally && (!framer || framer.sawTerminal);
    outcome.responseCompleted = endedNormally
      && (terminalObserver?.sawResponseCompleted || encodedTerminalObserver?.sawResponseCompleted || false);
  } finally {
    // Cancel upstream reader to stop consuming data nobody needs
    reader.cancel().catch(() => {});
    if (spillFile) await spillFile.close().catch(() => {});
    if (spillPath && !spillUnlinked) await unlink(spillPath).catch(() => {});
    framer?.dispose();
    if (!framer) terminalObserver?.dispose();
    encodedTerminalObserver?.dispose();
    releaseAuxiliaryResponseBytes(sseBufferBytes);
    // Only end a response whose headers went out — a deferred-headers response
    // being handed back for replay (preStreamFailure) must stay untouched.
    if (res.headersSent && !res.writableEnded) res.end();
  }
  return outcome;
}

// Anthropic usage objects split the prompt into three input families:
// `input_tokens` EXCLUDES the prompt cache, whose tokens arrive separately as
// `cache_creation_input_tokens` / `cache_read_input_tokens`. Claude Code keeps
// nearly the whole 1M context in cache, so counting `input_tokens` alone made the
// dashboard totals accumulate ~235 tokens/request (qjc, 2026-07-20 measured) —
// the real volume lives in the cache fields. Fold all three.
export function sumInputTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
}

function parseSSEUsage(event, account, accountManager) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === 'message_start' && data.message?.usage) {
      accountManager.updateUsage(account, sumInputTokens(data.message.usage), 0);
    } else if (data.type === 'message_delta' && data.usage) {
      accountManager.updateUsage(account, 0, data.usage.output_tokens);
    } else if (data.type === 'response.completed' && data.response?.usage) {
      accountManager.updateUsage(
        account,
        sumInputTokens(data.response.usage),
        data.response.usage.output_tokens,
      );
    }
  } catch {
    // not valid JSON, skip
  }
}

function extractUsageFromBody(buffer, account, accountManager) {
  try {
    const json = JSON.parse(buffer.toString());
    if (json.usage) {
      accountManager.updateUsage(account, sumInputTokens(json.usage), json.usage.output_tokens);
    }
  } catch {
    // not JSON or no usage
  }
}

// Seconds a client should wait before ANY account can serve again, derived from
// *why* each account is currently unusable — so an all-exhausted fleet tells the
// client the real (often hours-long) wait instead of a flat 60s it would just
// re-flood against every minute:
// An account is usable again only once BOTH its throttle AND every quota window
// it is currently past `threshold` on have cleared — so we take the LATEST (max)
// of them per account:
//   - an explicit throttle (a live exhaustion 429 → markRateLimited) is clamped
//     to <=5m, but the binding 5h/7d window that 429 came with may reset hours
//     later; the account stays `_isNearQuota` until then, so returning the
//     throttle alone made the client re-flood every 5 min while still exhausted;
//   - the quota reset is the unified 5h/7d reset the dashboard shows, NOT
//     `resetsAt` (a standard/API-key-only field the old code looked at, so a
//     utilization-exhausted Max fleet always fell through to the 60s default).
// A window UNDER threshold is not binding, so its (always-future) reset is
// ignored — and an account with NO binding constraint at all (quota-healthy,
// merely concurrency-capped or overflow-queued) contributes a short 60s
// candidate instead: its slot frees in seconds, so one healthy account caps the
// whole fleet's wait at the short fallback even when every other account is
// hours from reset. Disabled/auth-error accounts never return on a timer, so
// they're skipped. Falls back to 60s when nothing contributes anything.
function modelQuarantineRetryAfter(accounts, model) {
  if (typeof model !== 'string' || !model) return null;
  const now = Date.now();
  let soonest = Infinity;
  let eligible = 0;
  for (const account of accounts) {
    if (account.enabled === false || account.status === 'error') continue;
    eligible += 1;
    const until = account.unsupportedModels instanceof Map
      ? account.unsupportedModels.get(model)
      : null;
    if (!Number.isFinite(until) || until <= now) return null;
    soonest = Math.min(soonest, until);
  }
  if (eligible === 0 || soonest === Infinity) return null;
  return Math.max(1, Math.ceil((soonest - now) / 1000));
}

function computeRetryAfter(accounts, threshold = 0.98, model = null) {
  return fleetRecovery(accounts, threshold, model).retryAfter;
}

// Soonest the fleet has anything to serve: `retryAfter` (whole seconds, for
// headers/messages), `soonestMs` (the raw wait), and `soonestName` — the
// account whose KNOWN reset/throttle sets that wait, or null when the minimum
// is the 60s quota-healthy fallback (or the fleet is empty), i.e. when the
// wait is a guess rather than a reset the proxy can compare a budget against.
function fleetRecovery(accounts, threshold = 0.98, model = null) {
  const now = Date.now();
  const modelLabel = modelQuotaLabel(model);
  let soonest = Infinity;
  let soonestName = null;
  // `known` marks a minimum set by an actual reset/throttle timestamp (vs the
  // 60s quota-healthy guess). Tracked separately from the name because the
  // public status snapshot redacts account names (includeIdentity=false) — the
  // fail-fast decision must not silently disappear with the name.
  let soonestKnown = false;
  const consider = (ms, name = null, known = false) => {
    if (ms > 0 && ms < soonest) { soonest = ms; soonestName = name ?? null; soonestKnown = known; }
  };
  for (const acct of accounts) {
    if (acct.enabled === false || acct.status === 'error') continue;
    // freeAt = max(throttle, every over-threshold quota reset). The account is
    // blocked until the LAST of these clears; taking the min across accounts
    // then gives the soonest the fleet has anything to serve.
    let freeAt = 0;
    if (acct.rateLimitedUntil) freeAt = Math.max(freeAt, new Date(acct.rateLimitedUntil).getTime());
    const q = acct.quota || {};
    if (q.unified5h != null && q.unified5h >= threshold && q.unified5hReset)
      freeAt = Math.max(freeAt, q.unified5hReset);
    if (q.unified7d != null && q.unified7d >= threshold && q.unified7dReset)
      freeAt = Math.max(freeAt, q.unified7dReset);
    const modelWindow = modelLabel ? q.modelWeekly?.[modelLabel] : null;
    if (modelWindow?.utilization != null && modelWindow.utilization >= threshold
        && modelWindow.reset)
      freeAt = Math.max(freeAt, modelWindow.reset);
    // Standard windows reset independently — use each window's OWN reset
    // (falling back to the collapsed resetsAt for snapshots predating the
    // split fields), so when both are binding the LATER one wins instead of
    // resetsAt's preference for the sooner token reset.
    const tokensReset = q.tokensReset || q.resetsAt;
    if (q.tokensLimit != null && q.tokensRemaining != null && tokensReset
        && 1 - q.tokensRemaining / q.tokensLimit >= threshold)
      freeAt = Math.max(freeAt, new Date(tokensReset).getTime());
    const requestsReset = q.requestsReset || q.resetsAt;
    if (q.requestsLimit != null && q.requestsRemaining != null && requestsReset
        && 1 - q.requestsRemaining / q.requestsLimit >= threshold)
      freeAt = Math.max(freeAt, new Date(requestsReset).getTime());
    if (freeAt > 0) consider(freeAt - now, acct.name, true);
    else consider(60_000); // quota-healthy (merely capped/queued): a slot frees in seconds — cap the fleet wait at the short fallback
  }
  return {
    retryAfter: soonest === Infinity ? 60 : Math.max(1, Math.ceil(soonest / 1000)),
    soonestMs: soonest === Infinity ? null : soonest,
    soonestName,
    soonestKnown,
  };
}

// Plan spellings the Codex CLI deserializes into a known plan (upstream
// codex-rs/protocol/src/auth.rs `PlanType::from_str`, verified 2026-09-04). A
// value outside this set is omitted from the usage-limit body rather than
// risking an unparseable plan_type that would drop the CLI back to its opaque
// "exceeded retry limit" path.
const CODEX_KNOWN_PLAN_TYPES = new Set([
  'free', 'go', 'plus', 'pro', 'prolite', 'team',
  'self_serve_business_prolite', 'self_serve_business_usage_based',
  'business', 'ent26', 'enterprise_cbp_automation', 'enterprise_cbp_usage_based',
  'enterprise', 'hc', 'education', 'edu', 'edu_plus', 'edu_pro',
]);

// Plan to report for a fleet-wide codex exhaustion: the soonest-recovering
// account's plan (that is the account whose reset the message quotes), else
// the most common plan across the eligible pool. Null when unknown — the body
// then omits plan_type instead of guessing.
function codexPoolPlanType(accounts, soonestName = null) {
  const eligible = accounts.filter(a => a.enabled !== false && a.status !== 'error'
    && typeof a.planType === 'string' && CODEX_KNOWN_PLAN_TYPES.has(a.planType));
  const soonest = soonestName == null ? null : eligible.find(a => a.name === soonestName);
  if (soonest) return soonest.planType;
  const counts = new Map();
  for (const a of eligible) counts.set(a.planType, (counts.get(a.planType) || 0) + 1);
  let best = null;
  for (const [plan, n] of counts) {
    if (best == null || n > best.n) best = { plan, n };
  }
  return best?.plan ?? null;
}
