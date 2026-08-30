import { refreshAccessToken, isTokenExpiringSoon, normalizeExpiresAt } from './oauth.js';
import { refreshCodexAccessToken } from './codex.js';

const REFRESH_SWEEP_RETRY_MS = 5 * 60 * 1000;
const CODEX_SESSION_WINDOW_MINUTES = 5 * 60;
const CODEX_WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

/** Coerce a per-account / global concurrency cap to a positive integer, else fallback. */
function coerceMaxConcurrent(value, fallback) {
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function codexWindowKind(windowMinutes) {
  if (windowMinutes === CODEX_SESSION_WINDOW_MINUTES) return '5h';
  if (windowMinutes === CODEX_WEEKLY_WINDOW_MINUTES) return '7d';
  return null;
}

function normalizeResetMs(value) {
  if (value == null || value === '') return null;
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return null;
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function applyCodexQuotaWindow(quota, kind, usedPercent, resetAt, { authoritative = true } = {}) {
  if (!kind) return false;
  const utilization = Number(usedPercent);
  const reset = normalizeResetMs(resetAt);
  const utilKey = kind === '5h' ? 'unified5h' : 'unified7d';
  const resetKey = kind === '5h' ? 'unified5hReset' : 'unified7dReset';
  // Per-response x-codex headers are a live incremental signal, NOT an
  // authoritative meter: the Codex backend reports the rate limit that metered
  // THAT request, which for a promo/model-scoped meter (e.g. the
  // GPT-5.3-Codex-Spark additional limit) reads 0% while the account's binding
  // weekly window (wham/usage base rate_limit) sits at 89% (live incident
  // 2026-08-05: every forwarded response stamped unified7d back to 0 within
  // seconds of each wham refresh). Within one live window a same-meter
  // used-percent never decreases, so a NON-authoritative write that would
  // LOWER the stored utilization while the stored window is still in the
  // future is a different meter talking — skip the whole window (its reset is
  // just as suspect). The authoritative wham path may lower freely (window
  // rollover, upstream early reset), and an expired stored window may be
  // overwritten by anyone (legitimate rollover).
  if (!authoritative
      && Number.isFinite(utilization)
      && typeof quota[utilKey] === 'number'
      && utilization / 100 < quota[utilKey]
      && typeof quota[resetKey] === 'number'
      && quota[resetKey] > Date.now()) {
    return false;
  }
  let applied = false;
  if (Number.isFinite(utilization)) {
    quota[utilKey] = utilization / 100;
    applied = true;
  }
  if (reset != null) {
    quota[resetKey] = reset;
    applied = true;
  }
  return applied;
}

// Anthropic's `7d_oi` window is the top-tier weekly allowance shown as
// "Fable" in Claude's usage UI. It covers the Fable/Mythos model family;
// Opus is a fallback tier and must remain eligible when this window is full.
// Live claude-fable-5 429s report the binding claim in `7d_oi`.
// Keep the mapping in one place so selection, retry-after, and 429 handling use
// identical semantics. Unknown/future model tiers remain on unified routing.
export function modelQuotaLabel(model) {
  if (typeof model !== 'string') return null;
  return /(^|[-_.])(fable|mythos)($|[-_.\d])/i.test(model) ? '7d_oi' : null;
}

function emptyQuota() {
  return {
    // Standard API rate limits (API key accounts)
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    // Unified rate limits (Claude Max accounts)
    unified5h: null,       // utilization 0-1
    unified7d: null,       // utilization 0-1
    unified5hReset: null,  // ms timestamp
    unified7dReset: null,  // ms timestamp
    unifiedStatus: null,   // allowed | allowed_warning | rejected
    // Freshness stamp: ms timestamp of the last authoritative codex wham/usage
    // apply (updateCodexUsage). Per-response x-codex headers never set it —
    // they are a non-authoritative signal. Drives the active fast-lane refresh
    // (server.js maybeRefreshCodexUsage) and surfaces data age in status.
    codexUsageAt: null,
    // Model-scoped weekly windows, keyed by header window label — e.g. `7d_oi`,
    // the separate weekly limit for the top model tier shown as "Fable" in
    // Claude's usage UI. Parsed generically from
    // anthropic-ratelimit-unified-<window>-* so a renamed/added window keeps
    // being tracked without a code change. A complete, fresh, full window
    // pre-blocks only the matching model family; unknown/partial/expired values
    // remain selectable so the request itself can refresh them.
    modelWeekly: {},       // { '7d_oi': { utilization: 0-1, reset: msTimestamp } }
    resetsAt: null,        // soonest standard reset (session-order fallback)
    // Token and request windows can reset at DIFFERENT times; tracked separately
    // so retry-after can wait for whichever over-threshold window frees last
    // (resetsAt alone collapses them, preferring the sooner token reset).
    tokensReset: null,     // standard token-window reset (date string)
    requestsReset: null,   // standard request-window reset (date string)
  };
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.98, reevalIntervalMs = 5 * 60 * 1000, maxConcurrentDefault = 3, overflowQueueMaxDepth = 256) {
    this.maxConcurrentDefault = coerceMaxConcurrent(maxConcurrentDefault, 3);
    // Hard cap on the overflow queue so a flood of concurrent requests can't grow
    // it (and the buffered bodies / sockets / timers it pins) without bound. Past
    // this depth acquireAccount rejects immediately (→ 429) instead of queuing.
    this.maxQueueDepth = Number.isFinite(overflowQueueMaxDepth) && overflowQueueMaxDepth >= 0
      ? Math.floor(overflowQueueMaxDepth) : 256;
    this.accounts = accounts.map((acct, index) => ({
      index,
      name: acct.name,
      type: acct.type,
      provider: acct.provider || 'anthropic',
      accountUuid: acct.accountUuid || null,
      credential: acct.accessToken || acct.apiKey,
      refreshToken: acct.refreshToken || null,
      idToken: acct.idToken || null,
      accountId: acct.accountId || null,
      expiresAt: acct.expiresAt || null,
      status: acct.subscriptionDisabled === true && (acct.provider || 'anthropic') === 'anthropic'
        ? 'error' : 'active',
      subscriptionDisabled: acct.subscriptionDisabled === true
          && (acct.provider || 'anthropic') === 'anthropic'
        ? true : undefined,
      errorReason: acct.subscriptionDisabled === true
          && (acct.provider || 'anthropic') === 'anthropic'
        ? 'subscription-disabled' : undefined,
      _errorFromRefresh: acct.subscriptionDisabled === true
          && (acct.provider || 'anthropic') === 'anthropic'
        ? false : undefined,
      // Manual on/off switch. A disabled account is excluded from ALL rotation
      // (warm-up, use-or-lose selection, recover, acquire) via _isAvailable —
      // in-flight requests still drain, but no new request is routed to it.
      // Defaults to enabled; only an explicit `enabled: false` disables it.
      enabled: acct.enabled !== false,
      // Explicit selection priority: lower number = preferred first. Null/unset
      // means "no preference" — selection then falls back to use-or-lose. So a
      // config with no priorities behaves exactly as before.
      priority: Number.isFinite(acct.priority) ? Math.floor(acct.priority) : null,
      quota: emptyQuota(),
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalRequests: 0,
        lastUsed: null,
      },
      rateLimitedUntil: null,
      // Concurrency: how many requests are in flight through this account right
      // now, and the per-account cap above which the selector treats it as
      // momentarily full (so concurrent load spreads to other accounts).
      inflight: 0,
      maxConcurrent: coerceMaxConcurrent(acct.maxConcurrent, this.maxConcurrentDefault),
    }));
    this.currentIndex = 0;
    this.switchThreshold = switchThreshold;
    this.reevalIntervalMs = reevalIntervalMs;
    this.lastEvalAt = 0; // 0 forces a priority pick on the first request
    this.maxWarmupTries = 3; // give up warming an account after this many unmeasured attempts
    // Slow retry backstop for the active warm-up convergence cap: a capped
    // account (deterministic fruitless probes) is retried once per this window,
    // so an upstream that only LOOKED deterministic (e.g. temporarily
    // header-less) recovers without a restart, while a truly pathological one
    // costs at most one probe per window.
    this.probeRetryAfterMs = 15 * 60 * 1000;
    this._warmupCursor = 0;  // round-robin pointer used during warm-up
    this._waiters = [];      // overflow queue: requests waiting for a free slot
    // Soft connection→account affinity (keyed by the client socket). Keeps one
    // keep-alive connection's *sequential* requests on the same account so
    // Anthropic's per-account prompt cache stays warm. A WeakMap so an entry is
    // GC'd when the socket is collected (connection closed) — no manual cleanup,
    // no leak. The stored value is the account *object* (not its index, which
    // shifts on removeAccount); a stale entry is detected and ignored.
    this._affinity = new WeakMap();
  }

  /**
   * Get the account to use for the next request.
   *
   * Policy:
   *  - Cold-start warm-up: while any available account is still unmeasured,
   *    route to it so its quota (usage % / reset) gets populated before any
   *    priority decision is made on incomplete data.
   *  - If the current account is unavailable (near quota / throttled / error),
   *    switch immediately to the highest-priority account. This is the old
   *    "switch at threshold" trigger — but it now picks by priority rather
   *    than round-robin to the next index.
   *  - Otherwise re-evaluate priority at most once per `reevalIntervalMs`
   *    (default 5 min) and switch if a higher-priority account exists. Set
   *    `reevalIntervalMs <= 0` (config `reevalIntervalMs: 0`) to disable this
   *    timer entirely — the account then only changes when it becomes
   *    unavailable or via per-request 429 failover.
   *  - Between re-evaluations the current account is sticky, so a request
   *    stream stays on one account and keeps Anthropic's per-account prompt
   *    cache warm.
   *
   * Priority is "use-or-lose": soonest WEEKLY (7d) reset first, then soonest
   * session reset, then lowest session usage — so quota about to reset (and
   * otherwise be wasted) is consumed first, starting with the scarcer weekly
   * window. Returns null if every account is exhausted.
   */
  getActiveAccount(exclude = null, model = null) {
    const now = Date.now();

    // Per-request failover: a prior account already returned a non-quota 429
    // for THIS request (those accounts are in `exclude`, a Set of objects). Pick another available
    // account by priority WITHOUT touching the sticky primary or warm-up state
    // — this diverts only the overflow of one request; steady-state selection
    // still prefers the use-or-lose primary, keeping its prompt cache warm.
    // Returns null once every available account has been tried this request.
    if (exclude && exclude.size) return this._selectBest(exclude, model);

    const current = this.accounts[this.currentIndex];

    // Cold-start warm-up: until every available account has been measured at
    // least once, round-robin across the unmeasured accounts so their quota
    // (usage % / reset) gets populated. Round-robin (not "first unmeasured")
    // means a concurrent startup burst of any size spreads evenly instead of
    // hammering one unknown-quota account. Only once all are measured does the
    // use-or-lose priority below take over — with complete data.
    const warmup = this._nextWarmup(model);
    if (warmup) {
      if (warmup.index !== this.currentIndex) {
        console.log(`[TeamClaude] Warm-up: measuring account "${warmup.name}"`);
        this.currentIndex = warmup.index;
      }
      return warmup;
    }

    if (!this._isAvailable(current, model)) {
      const best = this._selectBest(null, model);
      if (best) {
        if (best.index !== this.currentIndex) {
          console.log(`[TeamClaude] Switched to account "${best.name}" (current unavailable)`);
        }
        this.currentIndex = best.index;
        this.lastEvalAt = now;
      }
      return best;
    }

    // Periodic re-prioritization. Disabled when reevalIntervalMs <= 0: the
    // current account then stays sticky and only changes when it becomes
    // unavailable (exhausted / throttled / error) or via per-request 429
    // failover — no timer-driven switching.
    if (this.reevalIntervalMs > 0 && now - this.lastEvalAt >= this.reevalIntervalMs) {
      this.lastEvalAt = now;
      const best = this._selectBest(null, model);
      if (best && best.index !== this.currentIndex) {
        console.log(`[TeamClaude] Re-prioritized to account "${best.name}" (weekly reset soonest)`);
        this.currentIndex = best.index;
        return best;
      }
    }

    // While the current account is still unmeasured, keep load-balancing via
    // _selectBest (which rotates among equal-rank accounts) instead of sticking
    // to an unknown-quota account — so a cold-start burst stays spread even
    // after per-account warm-up attempts are exhausted.
    if (!this._isMeasured(current)) {
      const best = this._selectBest(null, model);
      if (best) {
        this.currentIndex = best.index;
        return best;
      }
    }

    return current;
  }

  /**
   * Move the sticky primary to a different currently-available account without
   * changing persisted priority/enabled settings. Used by local recovery
   * control paths that must abandon the current account before retrying.
   */
  rotateActiveAccount(model = null, requireAccountUuid = false, failedAccountUuid = null) {
    const current = this.accounts[this.currentIndex] || null;
    const failed = typeof failedAccountUuid === 'string'
      ? this.accounts.find(account => account.accountUuid === failedAccountUuid) || null
      : current;
    if (typeof failedAccountUuid === 'string' && !failed) {
      return { rotated: false, reason: 'no-alternative-account' };
    }
    const exclude = new Set();
    if (failed) exclude.add(failed);
    if (requireAccountUuid) {
      for (const account of this.accounts) {
        if (!account.accountUuid) exclude.add(account);
      }
    }
    const next = this._selectBest(exclude, model);
    if (!next || next === failed) {
      return { rotated: false, reason: 'no-alternative-account' };
    }
    this.currentIndex = next.index;
    this.lastEvalAt = Date.now();
    return {
      rotated: true,
      previousAccount: failed?.name || null,
      previousAccountUuid: failed?.accountUuid || null,
      currentAccount: next.name,
      currentAccountUuid: next.accountUuid || null,
    };
  }

  // ── Concurrency layer: per-account in-flight cap + overflow queue ──────────
  //
  // getActiveAccount() above picks ONE account (sticky, use-or-lose). On its own
  // that funnels every concurrent terminal onto the same account, which then hits
  // Anthropic's per-account rate / concurrency limit (429) while other accounts
  // sit idle with quota to spare. The layer below fixes that PROACTIVELY: each
  // account carries an `inflight` counter and a `maxConcurrent` cap, and
  // acquireAccount() treats a capped account as momentarily unavailable (folds it
  // into the exclude set). The existing priority logic then naturally spreads
  // load to the next account — filling A up to its cap, then B, then C, by
  // use-or-lose priority. When every available account is at its cap the request
  // waits briefly for a slot to free (overflow queue) instead of 429-storming.

  /** Has this account a free concurrency slot? */
  _hasCapacity(account) {
    return account.inflight < account.maxConcurrent;
  }

  /**
   * Resolve an account handle to the live account object. Accepts the object
   * itself (reindex-safe — what server.js passes) or a numeric index (legacy /
   * tests). All public per-account methods route their first arg through this so
   * a stale index captured before a removeAccount() can't hit the wrong account.
   */
  _resolve(accountOrIndex) {
    return typeof accountOrIndex === 'number' ? this.accounts[accountOrIndex] : accountOrIndex;
  }

  /**
   * Available accounts currently at their concurrency cap, as a Set of account
   * OBJECTS (not indexes). Object identity is stable across a removeAccount()
   * re-index, so an exclude/capped set captured before the request awaits
   * upstream can't later point at the wrong account.
   */
  _cappedSet(exclude = null, model = null) {
    const capped = new Set();
    for (const a of this.accounts) {
      if (exclude && exclude.has(a)) continue;
      if (this._isAvailable(a, model) && !this._hasCapacity(a)) capped.add(a);
    }
    return capped;
  }

  /** Is there an available account with a free slot (not excluded)? Non-mutating. (`exclude` = Set of account objects.) */
  anyUsable(exclude = null, model = null) {
    return this.accounts.some(a =>
      this._isAvailable(a, model) && this._hasCapacity(a) && !(exclude && exclude.has(a)));
  }

  /** Is there an available-but-capped account (not excluded)? A freed slot could serve it. (`exclude` = Set of account objects.) */
  anyCapped(exclude = null, model = null) {
    return this.accounts.some(a =>
      this._isAvailable(a, model) && !this._hasCapacity(a) && !(exclude && exclude.has(a)));
  }

  /**
   * Synchronously pick + reserve the best account that is available AND has a
   * free concurrency slot, honoring `exclude`. Capped accounts are folded into
   * the exclusion so the existing getActiveAccount / _selectBest priority logic
   * (warm-up, use-or-lose, recover) only ever chooses an account that can take
   * the request. Increments the chosen account's inflight. Returns null when
   * nothing is currently acquirable (all exhausted, excluded, or capped).
   *
   * Single-threaded JS keeps this race-free: there is no await between selecting
   * the account and the inflight++ that reserves its slot.
   */
  _tryAcquire(
    exclude = null,
    affinityKey = null,
    model = null,
    preferredAccountUuid = null,
  ) {
    // Only an object/function is a valid WeakMap key. Ignore anything else (a
    // primitive key from an external caller would otherwise throw on get/set).
    const affOk = affinityKey != null
      && (typeof affinityKey === 'object' || typeof affinityKey === 'function');

    if (typeof preferredAccountUuid === 'string') {
      const preferred = this.accounts.find(
        account => account.accountUuid === preferredAccountUuid,
      );
      if (!preferred) return null;
      if (this._isAvailable(preferred, model)
          && !(exclude && exclude.has(preferred)) && this._hasCapacity(preferred)) {
        preferred.inflight++;
        if (affOk) this._affinity.set(affinityKey, preferred);
        return preferred;
      }
    }

    // Connection affinity (cache locality): prefer the account this connection
    // already used — but only as a *soft* hint, and DEFER to cold-start warm-up.
    // While any account still needs measuring, skip affinity so it can't pin all
    // of a connection's traffic to one account and starve the others of quota
    // data (warm-up round-robins the unmeasured accounts instead). Once measured,
    // affinity is honored only when that account is still available, has a free
    // slot, and isn't excluded for this request; otherwise it falls through to
    // normal selection. So it never exceeds a cap, revives an exhausted account,
    // or disturbs use-or-lose for new connections. (`accounts[idx] === a` rejects
    // a stale entry left by a removeAccount that re-indexed the array.)
    if (affOk && !this.accounts.some(acc => this._isWarmupTarget(acc, model))) {
      const a = this._affinity.get(affinityKey);
      // Require the home to be MEASURED — not just past its warm-up tries. A
      // headerless account stays unmeasured forever; pinning a connection to it
      // would bypass getActiveAccount's unmeasured-rebalance (which keeps
      // spreading to gather quota data / let tokens refresh on use). Once an
      // account returns rate-limit headers (every real Anthropic response does),
      // affinity engages normally.
      if (a && this.accounts[a.index] === a && this._isMeasured(a) && this._isAvailable(a, model)
          && this._hasCapacity(a) && !(exclude && exclude.has(a))) {
        a.inflight++;
        return a;
      }
    }

    const capped = this._cappedSet(exclude, model);
    const eff = ((exclude && exclude.size) || capped.size)
      ? new Set([...(exclude || []), ...capped])
      : null;
    // eff === null → full sticky / warm-up path (cold start, nothing capped).
    // eff set → getActiveAccount routes to _selectBest(eff), which already skips
    // every excluded + capped account.
    const account = eff ? this.getActiveAccount(eff, model) : this.getActiveAccount(null, model);
    if (account && this._isAvailable(account, model) && this._hasCapacity(account)
        && !(eff && eff.has(account))) {
      account.inflight++;
      // (Re)write affinity ONLY when the connection has no still-usable home.
      // Reaching this fall-through path means we left the home account — but that
      // can be merely transient: the home may be momentarily capped (overflow
      // spill) or failover-excluded for THIS request, yet still perfectly
      // available. Overwriting it then would let one blip permanently evict the
      // connection from its cache-warm account. So keep an available home (even
      // capped/excluded right now); replace it only when it's genuinely gone
      // (removed, unavailable, or exhausted — `_isAvailable` is false).
      if (affOk) {
        const home = this._affinity.get(affinityKey);
        const homeUsable = home && this.accounts[home.index] === home && this._isAvailable(home, model);
        if (!homeUsable) this._affinity.set(affinityKey, account);
      }
      return account;
    }
    return null;
  }

  /**
   * Acquire an account for a request, reserving one of its concurrency slots.
   * If none is immediately acquirable but an available account is merely at its
   * cap (overflow), wait up to `timeoutMs` for a slot to free — a releaseAccount
   * elsewhere wakes the waiter. Returns null when every account is genuinely
   * unavailable (quota-exhausted / auth-error / excluded) or the wait times out,
   * so the caller surfaces a 429 for the client to back off on.
   *
   * The caller MUST releaseAccount(account) exactly once when the request
   * (including any streamed body) finishes — pass the returned account OBJECT,
   * not its index, so a concurrent removeAccount() can't misattribute the slot.
   * `exclude` is a Set of account OBJECTS (per-request failover).
   */
  async acquireAccount(
    exclude = null,
    timeoutMs = 0,
    signal = null,
    affinityKey = null,
    model = null,
    preferredAccountUuid = null,
  ) {
    if (signal?.aborted) return null;
    if (typeof preferredAccountUuid === 'string'
        && !this.accounts.some(account => account.accountUuid === preferredAccountUuid)) {
      return null;
    }
    const account = this._tryAcquire(
      exclude,
      affinityKey,
      model,
      preferredAccountUuid,
    );
    if (account) return account;
    // Queue only when the blockage is cap-saturation (a slot WILL free as
    // in-flight requests finish) AND the queue isn't already full. If no
    // available account exists at all, or the queue is at its depth cap, return
    // null and let the caller 429 — never grow the backlog without bound.
    const canQueue = this.anyCapped(exclude, model);
    if (timeoutMs <= 0 || !canQueue || this.isQueueFull()) return null;
    return this._enqueue(
      exclude,
      timeoutMs,
      signal,
      affinityKey,
      model,
      preferredAccountUuid,
    );
  }

  /** Is the overflow queue at its depth cap? */
  isQueueFull() {
    return this._waiters.length >= this.maxQueueDepth;
  }

  /**
   * Upper bound on concurrent in-flight requests the proxy may admit (server.js
   * caps `inFlightProxied` to this to bound buffered memory): each ENABLED
   * account contributes its full cap (capacity it can still take), each DISABLED
   * account contributes only its *current* in-flight (requests still draining —
   * it accepts no new ones), plus the queue depth.
   *
   * This is the tightest bound that's still safe: it covers the draining requests
   * on a just-disabled account (so they can't push inFlightProxied over the
   * ceiling and 429 traffic the enabled accounts could serve), without admitting
   * fresh requests against a disabled account's dead future capacity (which could
   * only be buffered and then 429'd at acquire). As those draining requests
   * finish, the disabled account's contribution falls to zero.
   */
  totalCapacity() {
    const caps = this.accounts.reduce(
      (sum, a) => sum + (a.enabled === false ? a.inflight : a.maxConcurrent), 0);
    return caps + this.maxQueueDepth;
  }

  _enqueue(
    exclude,
    timeoutMs,
    signal = null,
    affinityKey = null,
    model = null,
    preferredAccountUuid = null,
  ) {
    return new Promise(resolve => {
      const waiter = {
        exclude,
        resolve,
        done: false,
        timer: null,
        signal,
        onAbort: null,
        affinityKey,
        model,
        preferredAccountUuid,
      };
      waiter.timer = setTimeout(() => this._settleWaiter(waiter, null), timeoutMs);
      // Cancel the wait if the client disconnects — otherwise an aborted request
      // would still acquire a slot later and be dispatched upstream, burning quota.
      if (signal) {
        waiter.onAbort = () => this._settleWaiter(waiter, null);
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this._waiters.push(waiter);
    });
  }

  /** Resolve a queued waiter exactly once, cleaning up its timer/abort listener. */
  _settleWaiter(waiter, value) {
    if (waiter.done) return false;
    waiter.done = true;
    clearTimeout(waiter.timer);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort);
    const i = this._waiters.indexOf(waiter);
    if (i >= 0) this._waiters.splice(i, 1);
    waiter.resolve(value);
    return true;
  }

  /**
   * Release a concurrency slot held by a request and hand any freed capacity to
   * the longest-waiting overflow request that can use it (FIFO, but a waiter
   * whose exclude set can't currently be satisfied is skipped rather than
   * head-of-line blocking a later waiter that can run).
   */
  releaseAccount(accountOrIndex) {
    // Resolve to the account OBJECT (what the server holds — reindex-safe across a
    // removeAccount) so a release decrements the slot of the *account that was
    // acquired*, never whatever happens to sit at that index now. A numeric index
    // is still accepted for convenience/tests.
    const account = this._resolve(accountOrIndex);
    if (account && account.inflight > 0) account.inflight--;
    this._drainWaiters();
  }

  _drainWaiters() {
    for (let i = 0; i < this._waiters.length;) {
      const waiter = this._waiters[i];
      const account = this._tryAcquire(
        waiter.exclude,
        waiter.affinityKey,
        waiter.model,
        waiter.preferredAccountUuid,
      );
      if (account) {
        // _settleWaiter splices the waiter out, so don't advance i. If it was
        // already settled (shouldn't happen — settled waiters aren't in the list),
        // give the slot back instead of leaking it.
        if (!this._settleWaiter(waiter, account)) { account.inflight--; i++; }
        continue;
      }
      // No slot right now. If no account this waiter could use is even
      // available-but-capped, nothing will ever free for it (e.g. the account it
      // was queued for just got disabled or exhausted) — settle it null so it
      // releases its finite queue slot instead of blocking later, satisfiable
      // overflow requests until its timeout. A waiter that still has a cappable
      // account to hope for is left in place.
      const preferred = typeof waiter.preferredAccountUuid === 'string'
        ? this.accounts.find(account => account.accountUuid === waiter.preferredAccountUuid)
        : null;
      const canWait = waiter.preferredAccountUuid == null
        ? this.anyCapped(waiter.exclude, waiter.model)
        : preferred && this._isAvailable(preferred, waiter.model)
          && !this._hasCapacity(preferred)
          && !(waiter.exclude && waiter.exclude.has(preferred));
      if (!canWait) { this._settleWaiter(waiter, null); continue; }
      i++;
    }
  }

  /**
   * Highest-priority available account by use-or-lose ordering: soonest WEEKLY
   * (7d) reset first — weekly quota is the scarce resource, so an account whose
   * week is about to renew (and whose unspent quota would be wasted) is drained
   * first — then soonest session reset, then lowest session utilization. Falls
   * back to the soonest-resetting account when none are currently available.
   *
   * `exclude` (a Set of account objects) is used for per-request failover: those
   * accounts are skipped, and when nothing else is eligible this returns null
   * (instead of recovering one) so the caller can pass the 429 through.
   */
  _selectBest(exclude = null, model = null) {
    const has = a => (exclude ? exclude.has(a) : false);
    const eligible = this.accounts.filter(a => this._isAvailable(a, model) && !has(a));
    if (eligible.length === 0) return exclude ? null : this._recoverSoonest(model);

    eligible.sort((a, b) => {
      const pa = this._priority(a);
      const pb = this._priority(b);
      if (pa !== pb) return pa - pb;                                     // explicit priority first (lower = preferred)
      return this.autoCompare(a, b);                                     // then the automatic use-or-lose order
    });

    // Accounts tied for the best rank (notably all-unknown at cold start, or all
    // sharing one priority) are load-balanced round-robin instead of always
    // pinning to the lowest index, so a startup burst can't pile onto one account
    // before quotas are known.
    const p0 = this._priority(eligible[0]);
    const w0 = this._weeklyResetTime(eligible[0]);
    const r0 = this._sessionResetTime(eligible[0]);
    const u0 = this._sessionUtilization(eligible[0]);
    const tied = eligible
      .filter(a => this._priority(a) === p0
        && this._weeklyResetTime(a) === w0
        && this._sessionResetTime(a) === r0
        && this._sessionUtilization(a) === u0)
      .sort((a, b) => a.index - b.index);
    if (tied.length <= 1) return eligible[0];
    return tied.find(a => a.index > this.currentIndex) || tied[0];
  }

  /**
   * Explicit selection priority: lower = preferred. Unset (null) sorts last
   * (Infinity) so an account WITH any finite priority — however large — is chosen
   * ahead of those without. When no account sets a priority, every account ties
   * here (Infinity === Infinity) and the sort falls through to use-or-lose, i.e.
   * the original behavior unchanged. The callers compare with a `pa !== pb` guard
   * before any subtraction, so Infinity never produces a NaN sort key.
   */
  _priority(account) {
    return Number.isFinite(account.priority) ? account.priority : Infinity;
  }

  /**
   * The automatic ("auto") use-or-lose comparator, shared by selection and the
   * TUI display order: soonest WEEKLY reset (drain what renews first) → soonest
   * session reset → lowest session utilization. Returns 0 on a full tie, so a
   * stable sort keeps ties in array order (the pre-weekly behavior for API-key
   * fleets and unmeasured accounts).
   */
  autoCompare(a, b) {
    const wa = this._weeklyResetTime(a);
    const wb = this._weeklyResetTime(b);
    if (wa !== wb) return wa - wb;
    const ra = this._sessionResetTime(a);
    const rb = this._sessionResetTime(b);
    if (ra !== rb) return ra - rb;
    return this._sessionUtilization(a) - this._sessionUtilization(b);
  }

  /**
   * Weekly reset timestamp (ms): unified 7d (Max) → Infinity. API-key accounts
   * have no weekly window, so they tie at Infinity and the session tiebreak
   * decides — exactly the pre-weekly-ordering behavior. The window counts only
   * when BOTH utilization and reset are present: a partial/garbled header pair
   * (reset without utilization) must not outrank accounts with no 7d data,
   * matching the documented "no weekly data ranks at Infinity" semantics.
   *
   * A timestamp that has PASSED ranks at Infinity too: the moment a window
   * rolls over, the account's old "resets soonest" claim is void (its fresh
   * window is unknown until re-measured) — without this, the past timestamp
   * (smallest value) would pin the account at the top of the order until a
   * request-path sweep happened to clear it, so the order would NOT follow
   * reset rollovers. The lazy sweep in _isNearQuota still clears the fields;
   * this just makes ORDERING (selection and the TUI display, which has no
   * sweep) reflect the rollover instantly.
   */
  _weeklyResetTime(account) {
    const q = account.quota;
    const r = (q.unified7d != null && q.unified7dReset) ? q.unified7dReset : Infinity;
    return r > Date.now() ? r : Infinity;
  }

  /**
   * Session reset timestamp (ms): unified 5h (Max) → standard reset → Infinity.
   * Expired timestamps rank at Infinity for the same rollover reason as
   * _weeklyResetTime above.
   */
  _sessionResetTime(account) {
    const q = account.quota;
    const r = q.unified5hReset
      || (q.resetsAt ? new Date(q.resetsAt).getTime() : Infinity);
    return r > Date.now() ? r : Infinity;
  }

  /** Session utilization 0–1: unified 5h (Max) → standard token/request usage → 0. */
  _sessionUtilization(account) {
    const q = account.quota;
    if (q.unified5h != null) return q.unified5h;
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      return 1 - q.tokensRemaining / q.tokensLimit;
    }
    if (q.requestsLimit != null && q.requestsRemaining != null) {
      return 1 - q.requestsRemaining / q.requestsLimit;
    }
    return 0;
  }

  /**
   * Clear every account's expired quota windows NOW. The lazy sweep inside
   * _isNearQuota only runs on selection paths (i.e. when a request flows), so
   * on an idle proxy a rolled-over window would keep its stale values — and
   * stay "measured", which prevents the periodic active warm-up from
   * re-probing it. The server's warm-up timer calls this first, closing the
   * loop: rollover → sweep → unmeasured → probe → fresh data → order updates.
   * Idempotent and cheap (pure field clears).
   */
  sweepExpired() {
    for (const a of this.accounts) this._isNearQuota(a);
  }

  /** True once we have any quota data for this account (rate-limit headers seen). */
  _isMeasured(account) {
    const q = account.quota;
    return q.unified5h != null || q.unified7d != null
      || q.tokensLimit != null || q.requestsLimit != null;
  }

  /**
   * Fully measured, for ACTIVE warm-up candidacy: an OAuth (Max) response
   * always carries both the 5h and the 7d window, so a missing half — e.g. a
   * weekly rollover swept `unified7d` while the session window survived —
   * means the account needs a re-probe or its weekly quota/ordering stays
   * unknown until real traffic reaches it. One probe repopulates both windows,
   * so candidacy converges. API-key accounts keep the any-data semantics.
   */
  _fullyMeasured(account) {
    if (account.type === 'oauth') {
      // A window counts only when COMPLETE (utilization AND reset) — the same
      // semantics the ordering helpers use. Utilization without its reset
      // timestamp gives use-or-lose nothing to sort on, so such an account
      // still needs a re-probe.
      const q = account.quota;
      return q.unified5h != null && q.unified5hReset != null
        && q.unified7d != null && q.unified7dReset != null;
    }
    return this._isMeasured(account);
  }

  /**
   * A fully-measured OAuth account whose model-scoped weekly window (the Fable
   * `7d_oi` limit) is still absent. Such a window only appears on responses to
   * Fable-tier requests, so an account that was measured by lower-tier traffic
   * or a lower-tier probe keeps its `Fbl` bar blank — and because it IS fully
   * measured for 5h/7d, ordinary warm-up (which only targets unmeasured
   * accounts) never re-probes it. This flags it for a bounded model-weekly
   * top-up probe, run ONLY when the committed probe template can actually
   * elicit the window (see server.js). The `_mwProbes` cap stops an account
   * whose upstream genuinely never reports the window from being probed every
   * interval forever; it resets when the window populates or a quota window is
   * swept (a fresh week is a fresh reason to look).
   */
  needsModelWeekly(account) {
    return account.type === 'oauth'
      && this._fullyMeasured(account)
      && Object.keys(account.quota.modelWeekly).length === 0
      && (account._mwProbes || 0) < this.maxWarmupTries;
  }

  /**
   * A PARTIALLY-measured OAuth account: one unified window is present but the
   * other is missing, so it is neither fully measured nor a candidate for either
   * automatic re-probe path. This is the post-restart weekly-only case: the lazy
   * sweep clears an EXPIRED session (5h) window while a still-future weekly (7d)
   * window survives — and when that weekly window is exhausted no real traffic
   * reaches the account to repopulate the rest either.
   *
   * Why `_isMeasured` (any-data) gating misses it: `_isMeasured` is already true
   * from the surviving window, so `warmupUnmeasured` won't re-probe it; yet
   * `needsModelWeekly` requires `_fullyMeasured`, so that path skips it too. Its
   * session/Fable numbers would stay a permanent blank. Flag it for a FORCED
   * re-probe (one response repopulates both windows). `_partialProbes` — already
   * managed by warmupAccount (reset to 0 on a fully-measured probe, incremented
   * on a half-measured one) — caps the retries so a genuinely half-reporting
   * upstream is not probed every interval forever.
   */
  needsPartialRemeasure(account) {
    return account.type === 'oauth'
      && this._isMeasured(account)
      && !this._fullyMeasured(account)
      && (account._partialProbes || 0) < this.maxWarmupTries;
  }

  /**
   * An account still needing warm-up: available, not yet MEASURED, under the
   * per-account attempt cap.
   *
   * Keying on `!_isMeasured` (not on "has it made a request") is deliberate: a
   * request can return *no* rate-limit headers — a `HEAD /` health check, a
   * 404, an auth failure — which would leave the account unmeasured. Gating
   * warm-up on `totalRequests === 0` used to permanently disqualify such an
   * account after that single header-less request, trapping it as "unmeasured"
   * forever: it then sorts to the bottom of use-or-lose priority (no reset
   * data) and the unmeasured-rebalance bounces any switch away from it, so it
   * never gets used again — and its token never gets refreshed, so it expires.
   *
   * maxWarmupTries provides the loop-safety instead: a genuinely dead account
   * (always header-less / 401) is abandoned after a few attempts rather than
   * looping forever. (An expired-token account is resolved on its first warm-up
   * routing anyway — ensureTokenFresh either refreshes it into a measurable
   * state or marks it `error`, which makes it unavailable here.)
   */
  _isWarmupTarget(account, model = null) {
    return this._isAvailable(account, model)
      && !this._isMeasured(account)
      && (account._warmupTries || 0) < this.maxWarmupTries;
  }

  /**
   * Next account to warm up, round-robin across the warm-up targets so a burst
   * spreads evenly. Advances the cursor and bumps the chosen account's attempt
   * counter synchronously, so concurrent calls pick different accounts even
   * before any response arrives. Returns null when no target remains.
   */
  _nextWarmup(model = null) {
    const n = this.accounts.length;
    for (let i = 0; i < n; i++) {
      const idx = (this._warmupCursor + i) % n;
      const a = this.accounts[idx];
      if (this._isWarmupTarget(a, model)) {
        this._warmupCursor = idx + 1;
        a._warmupTries = (a._warmupTries || 0) + 1;
        return a;
      }
    }
    return null;
  }

  /**
   * Accounts eligible for an *active* warm-up probe: available (enabled, not
   * throttled / exhausted / error), with no quota data yet, AND not already
   * handling a request. The server sends each one a minimal upstream request to
   * populate its quota so the dashboard reflects the whole fleet shortly after a
   * (re)start, instead of waiting for client traffic to organically reach every
   * account.
   *
   * `inflight === 0` matters: a request already in flight will itself populate
   * the account's quota (updateQuota runs on its response headers), so probing it
   * would just race that request and waste an upstream call. Cold start's very
   * first request holds its (still-unmeasured) account here, so the startup
   * fan-out probes only the genuinely idle rest of the fleet — never the account
   * that request is already measuring. (An unmeasured account can't be near-quota,
   * so no extra status carve-outs are needed beyond _isAvailable.)
   */
  warmupCandidates() {
    return this.accounts.filter(a =>
      this._isAvailable(a) && !this._fullyMeasured(a) && a.inflight === 0
      // Convergence cap: against the real upstream one probe fully measures an
      // account (responses always carry both window families), but a
      // pathological upstream — a 2xx missing a family, header-less responses,
      // or a deterministic 4xx — must not be probed every interval forever. A
      // probe that completes with such a deterministic fruitless outcome
      // increments _partialProbes (transient 5xx/429/network failures don't
      // count — see warmupAccount); after maxWarmupTries fruitless probes the
      // account stops being a candidate. The counter resets when a window is
      // swept (a fresh rollover is a fresh reason to probe) or when the
      // account becomes fully measured — and, because a fully UNMEASURED
      // account has no reset timestamp for the sweep to fire on, a capped
      // account is retried once per probeRetryAfterMs as a slow backstop, so a
      // "deterministic-looking" outage (e.g. headers temporarily missing) still
      // recovers instead of suppressing active warm-up until a restart.
      && ((a._partialProbes || 0) < this.maxWarmupTries
        || Date.now() - (a._lastFruitlessProbeAt || 0) >= this.probeRetryAfterMs));
  }

  _isAvailable(account, model = null) {
    if (!account) return false;

    // Manually disabled accounts are out of rotation entirely. This single gate
    // covers every selection path (warm-up target, _selectBest, _cappedSet,
    // anyUsable/anyCapped, the sticky-current check) so a disabled account is
    // never chosen for a new request. _recoverSoonest iterates accounts directly
    // (not via this), so it skips disabled accounts itself.
    if (account.enabled === false) return false;

    // Check rate limit expiry
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (Date.now() < account.rateLimitedUntil) return false;
      account.status = 'active';
      account.rateLimitedUntil = null;
      console.log(`[TeamClaude] Account "${account.name}" rate limit expired, marking active`);
    }

    if (account.status === 'exhausted' || account.status === 'error') return false;
    if (this._isNearQuota(account, model)) return false;

    return true;
  }

  _isNearQuota(account, model = null) {
    const q = account.quota;
    const now = Date.now();

    // Clear expired unified quotas. The reset timestamp is cleared even when the
    // matching utilization was never set (a partial/garbled header pair) — a
    // stale past timestamp would otherwise survive forever and, since selection
    // sorts by reset time, permanently bias the ordering toward that account.
    if (q.unified5hReset && now >= q.unified5hReset) {
      if (q.unified5h != null) console.log(`[TeamClaude] Account "${account.name}" session quota reset`);
      q.unified5h = null;
      q.unified5hReset = null;
      // Fresh rollover → BOTH warm-up budgets renew: active probes
      // (_partialProbes) and the passive request-routing warm-up
      // (_warmupTries) get a fresh reason to re-measure this window.
      account._partialProbes = 0;
      account._warmupTries = 0;
    }
    if (q.unified7dReset && now >= q.unified7dReset) {
      if (q.unified7d != null) console.log(`[TeamClaude] Account "${account.name}" weekly quota reset`);
      q.unified7d = null;
      q.unified7dReset = null;
      q.unifiedStatus = null;
      account._partialProbes = 0; // fresh rollover → re-probes allowed again
      account._warmupTries = 0;
    }
    // Clear expired model-scoped weekly windows. Stale values would mislead
    // selection, the dashboard, and 429 retry-time calculation. A cleared window
    // is a fresh reason to top it up again, so renew the model-weekly probe budget.
    for (const [label, win] of Object.entries(q.modelWeekly)) {
      if (win.reset && now >= win.reset) {
        console.log(`[TeamClaude] Account "${account.name}" ${label} quota reset`);
        delete q.modelWeekly[label];
        account._mwProbes = 0;
      }
    }

    if (this._isModelNearQuota(account, model, now)) return true;

    // Clear expired standard quotas — each window INDEPENDENTLY. The token and
    // request windows reset at different times; sweeping both on the collapsed
    // resetsAt (token-first) made a still-blocked request window vanish the
    // moment the sooner token window reset, freeing the account ~an hour early.
    // A window without its own reset falls back to resetsAt (old snapshots /
    // upstreams that only send one reset header) — same sweep as before.
    const tokensResetAt = q.tokensReset || q.resetsAt;
    if (tokensResetAt && now >= new Date(tokensResetAt).getTime()) {
      q.tokensRemaining = null;
      q.tokensLimit = null;
      q.tokensReset = null;
    }
    const requestsResetAt = q.requestsReset || q.resetsAt;
    if (requestsResetAt && now >= new Date(requestsResetAt).getTime()) {
      q.requestsRemaining = null;
      q.requestsLimit = null;
      q.requestsReset = null;
    }
    // Advance the collapsed resetsAt (session-ordering fallback) to the soonest
    // still-future window reset, or clear it once no window remains.
    if (q.resetsAt && now >= new Date(q.resetsAt).getTime()) {
      const future = [q.tokensReset, q.requestsReset]
        .map(r => (r ? new Date(r).getTime() : null))
        .filter(t => t && t > now);
      q.resetsAt = future.length ? new Date(Math.min(...future)).toISOString() : null;
    }

    // Unified quotas (Claude Max) — utilization is already 0-1
    if (q.unified5h != null && q.unified5h >= this.switchThreshold) return true;
    if (q.unified7d != null && q.unified7d >= this.switchThreshold) return true;

    // Standard quotas (API key accounts)
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      const used = 1 - (q.tokensRemaining / q.tokensLimit);
      if (used >= this.switchThreshold) return true;
    }

    if (q.requestsLimit != null && q.requestsRemaining != null) {
      const used = 1 - (q.requestsRemaining / q.requestsLimit);
      if (used >= this.switchThreshold) return true;
    }

    return false;
  }

  _isModelNearQuota(account, model, now = Date.now()) {
    const label = modelQuotaLabel(model);
    if (!label) return false;
    const win = account.quota.modelWeekly[label];
    return Number.isFinite(win?.utilization)
      && Number.isFinite(win?.reset)
      && win.reset > now
      && win.utilization >= this.switchThreshold;
  }

  /** When all accounts are unavailable, return the soonest to reset (if it has already reset). */
  _recoverSoonest(model = null) {
    let soonestAccount = null;
    let soonestTime = Infinity;

    for (const account of this.accounts) {
      // Never recover a manually-disabled account into rotation.
      if (account.enabled === false) continue;
      if (account.subscriptionDisabled === true) continue;
      if (this._isModelNearQuota(account, model)) continue;
      const resetTime = account.rateLimitedUntil
        || account.quota.unified5hReset
        || account.quota.unified7dReset
        || (account.quota.resetsAt ? new Date(account.quota.resetsAt).getTime() : null);

      if (resetTime && resetTime < soonestTime) {
        soonestTime = resetTime;
        soonestAccount = account;
      }
    }

    if (soonestAccount && soonestTime <= Date.now()) {
      soonestAccount.status = 'active';
      soonestAccount.rateLimitedUntil = null;
      this.currentIndex = soonestAccount.index;
      console.log(`[TeamClaude] Account "${soonestAccount.name}" reset, switching to it`);
      return soonestAccount;
    }

    return null;
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  updateQuota(accountIndex, headers) {
    const account = this._resolve(accountIndex);
    if (!account) return;

    // Unified rate limits (Claude Max)
    const u5h = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']);
    const u7d = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']);
    if (!isNaN(u5h)) account.quota.unified5h = u5h;
    if (!isNaN(u7d)) account.quota.unified7d = u7d;

    const r5h = headers['anthropic-ratelimit-unified-5h-reset'];
    const r7d = headers['anthropic-ratelimit-unified-7d-reset'];
    if (r5h) account.quota.unified5hReset = parseInt(r5h, 10) * 1000;
    if (r7d) account.quota.unified7dReset = parseInt(r7d, 10) * 1000;

    // Codex labels windows as primary/secondary, but those positions are not
    // stable: a weekly-only plan can report its 10080-minute window as primary.
    // Classify by the advertised duration. Older responses without a duration
    // retain the legacy primary=5h / secondary=7d fallback.
    for (const [prefix, fallbackKind] of [['primary', '5h'], ['secondary', '7d']]) {
      const minutes = Number(headers[`x-codex-${prefix}-window-minutes`]);
      const kind = Number.isFinite(minutes) && minutes > 0
        ? codexWindowKind(minutes)
        : fallbackKind;
      applyCodexQuotaWindow(
        account.quota,
        kind,
        headers[`x-codex-${prefix}-used-percent`],
        headers[`x-codex-${prefix}-reset-at`],
        // Response headers describe whichever meter governed THIS request; only
        // the wham/usage refresh (updateCodexUsage) is authoritative for the
        // account's binding windows. See applyCodexQuotaWindow.
        { authoritative: false },
      );
    }

    const uStatus = headers['anthropic-ratelimit-unified-status'];
    const codexReached = headers['x-codex-rate-limit-reached-type'];
    account.quota.unifiedStatus = uStatus || (codexReached ? 'rejected' : null);

    // Model-scoped weekly windows (7d_<label>), e.g. `7d_oi` — the weekly limit
    // for the top model tier ("Fable" in Claude's usage UI). These headers only
    // appear on responses to requests for that model tier, so the value sticks
    // around from the last such request. Matched generically so a renamed or
    // newly added window is picked up as-is.
    for (const [key, value] of Object.entries(headers)) {
      const m = /^anthropic-ratelimit-unified-(7d_[a-z0-9_]+)-(utilization|reset)$/.exec(key);
      if (!m) continue;
      const win = account.quota.modelWeekly[m[1]]
        || (account.quota.modelWeekly[m[1]] = { utilization: null, reset: null });
      if (m[2] === 'utilization') {
        const u = parseFloat(value);
        if (!isNaN(u)) win.utilization = u;
      } else {
        const r = parseInt(value, 10);
        if (!isNaN(r)) win.reset = r * 1000;
      }
    }

    // Standard rate limits (API key accounts)
    const tokensLimit = parseInt(headers['anthropic-ratelimit-tokens-limit'], 10);
    const tokensRemaining = parseInt(headers['anthropic-ratelimit-tokens-remaining'], 10);
    const tokensReset = headers['anthropic-ratelimit-tokens-reset'];
    const requestsLimit = parseInt(headers['anthropic-ratelimit-requests-limit'], 10);
    const requestsRemaining = parseInt(headers['anthropic-ratelimit-requests-remaining'], 10);
    const requestsReset = headers['anthropic-ratelimit-requests-reset'];

    if (!isNaN(tokensLimit)) account.quota.tokensLimit = tokensLimit;
    if (!isNaN(tokensRemaining)) account.quota.tokensRemaining = tokensRemaining;
    if (!isNaN(requestsLimit)) account.quota.requestsLimit = requestsLimit;
    if (!isNaN(requestsRemaining)) account.quota.requestsRemaining = requestsRemaining;

    if (tokensReset) account.quota.tokensReset = tokensReset;
    if (requestsReset) account.quota.requestsReset = requestsReset;
    if (tokensReset) account.quota.resetsAt = tokensReset;
    else if (requestsReset) account.quota.resetsAt = requestsReset;

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = account.quota.unified7d != null
        ? (account.quota.unified7d * 100).toFixed(1)
        : account.quota.unified5h != null
          ? (account.quota.unified5h * 100).toFixed(1)
          : account.quota.tokensLimit
            ? ((1 - account.quota.tokensRemaining / account.quota.tokensLimit) * 100).toFixed(1)
            : '?';
      console.log(`[TeamClaude] Account "${account.name}" at ${pct}% usage — will switch on next request`);
    }
  }

  /**
   * Fold the official Codex /wham/usage response into the shared quota model.
   * The base rate limit wins; additional Codex limits only fill a duration that
   * the base response did not include. Unrecognized windows are ignored.
   */
  updateCodexUsage(accountIndex, payload) {
    const account = this._resolve(accountIndex);
    if (!account || !payload || typeof payload !== 'object') return false;
    // A parsed usage response IS fresh contact with the source, even when it
    // carries no recognizable 5h/7d window (an upstream contract change must
    // not turn the active fast lane into an unbounded per-request poll).
    account.quota.codexUsageAt = Date.now();

    const limits = [];
    if (payload.rate_limit && typeof payload.rate_limit === 'object') {
      limits.push(payload.rate_limit);
    }
    if (Array.isArray(payload.additional_rate_limits)) {
      for (const item of payload.additional_rate_limits) {
        if (item?.limit_name !== 'codex') continue;
        if (item?.rate_limit && typeof item.rate_limit === 'object') limits.push(item.rate_limit);
      }
    }

    const windows = new Map();
    for (const limit of limits) {
      for (const window of [limit.primary_window, limit.secondary_window]) {
        if (!window || typeof window !== 'object') continue;
        const minutes = window.window_minutes != null && Number.isFinite(Number(window.window_minutes))
          ? Number(window.window_minutes)
          : Number(window.limit_window_seconds) / 60;
        const kind = codexWindowKind(minutes);
        if (!kind || windows.has(kind)) continue;
        windows.set(kind, window);
      }
    }

    let applied = false;
    for (const [kind, window] of windows) {
      const resetAt = window.reset_at ?? (window.reset_after_seconds != null
        && Number.isFinite(Number(window.reset_after_seconds))
        ? Date.now() / 1000 + Number(window.reset_after_seconds)
        : null);
      applied = applyCodexQuotaWindow(
        account.quota,
        kind,
        window.used_percent,
        resetAt,
      ) || applied;
    }
    return applied;
  }

  /**
   * Update cumulative token usage from response body data.
   */
  updateUsage(accountIndex, inputTokens, outputTokens) {
    const account = this._resolve(accountIndex);
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;
  }

  /**
   * Does a 429 from this account indicate genuine *account-level quota
   * exhaustion* (vs a transient / global / IP / request-level 429)?
   *
   * Only exhaustion 429s should throttle the account and trigger a switch to
   * another account. A non-exhaustion 429 must NOT be replayed across the
   * fleet — otherwise a single request whose 429 is request-global (e.g. a
   * malformed request, an org/IP limit, or a momentary upstream blip) would
   * poison every account and make unrelated requests fail too.
   *
   * Call this *after* updateQuota() has folded the 429's rate-limit headers
   * into the account's quota state.
   *
   * Model-scoped windows (quota.modelWeekly, e.g. the Fable 7d_oi limit) are
   * deliberately NOT consulted here. `isModelExhausted()` classifies them after
   * a live response so server.js can fail over or fall back without globally
   * throttling an account that still serves Opus/Sonnet/Haiku.
   */
  isExhausted(accountIndex) {
    const account = this._resolve(accountIndex);
    if (!account) return false;
    // Claude Max: upstream explicitly rejects when over the unified limit.
    if (account.quota.unifiedStatus === 'rejected') return true;
    // Otherwise rely on measured utilization (unified or standard headers).
    return this._isNearQuota(account);
  }

  /** Is this account exhausted only for the requested model tier? */
  isModelExhausted(accountIndex, model) {
    const account = this._resolve(accountIndex);
    const label = modelQuotaLabel(model);
    if (!account || !label) return false;
    // Sweep expired windows before reading the model-specific value.
    this._isNearQuota(account);
    return this._isModelNearQuota(account, model);
  }

  /**
   * Mark an account as rate-limited for a given duration.
   */
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this._resolve(accountIndex);
    if (!account) return;
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfterSeconds * 1000);
    console.log(`[TeamClaude] Account "${account.name}" rate limited for ${retryAfterSeconds}s`);
  }

  /**
   * Ensure an OAuth account's token is fresh, refreshing if needed.
   * Pass force=true to refresh regardless of expiry (e.g. after a 401).
   * Concurrent calls for the same account coalesce into a single refresh.
   */
  async ensureTokenFresh(accountIndex, force = false) {
    const account = this._resolve(accountIndex);
    if (!account || account.type !== 'oauth' || !account.refreshToken) return;

    if (!force && !isTokenExpiringSoon(account.expiresAt)) return;

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    account._refreshPromise = (async () => {
      const previousTokens = {
        accessToken: account.credential,
        refreshToken: account.refreshToken,
        expiresAt: account.expiresAt,
      };
      console.log(`[TeamClaude] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = account.provider === 'codex'
          ? await refreshCodexAccessToken(account.refreshToken)
          : await refreshAccessToken(account.refreshToken);
        // Another live sync may have installed a newer rotated token while this
        // network request was in flight. Never let the late result from the old
        // refresh token replace that newer credential.
        if (account.credential !== previousTokens.accessToken
          || account.refreshToken !== previousTokens.refreshToken) {
          console.log(`[TeamClaude] Discarded stale token refresh for account "${account.name}"`);
          return;
        }
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        if (newTokens.idToken) account.idToken = newTokens.idToken;
        if (newTokens.accountId) {
          account.accountId = newTokens.accountId;
          account.accountUuid = newTokens.accountId;
        }
        // A token endpoint success only proves a prior refresh failure healed.
        // Request-path errors (fresh-token 401 or non-transient send failure)
        // stay parked until new external credentials arrive or the proxy restarts.
        if (account.status === 'error' && account._errorFromRefresh) {
          account.status = 'active';
          delete account._errorFromRefresh;
        }
        delete account._refreshRetryAt;
        console.log(`[TeamClaude] Token refreshed for account "${account.name}"`);
        // Only persist if the account is still live at its claimed index. If it was
        // removed during the (awaited) network refresh, its `.index` is stale and
        // would misattribute the write to the survivor that shifted into that slot
        // — and a deleted account's tokens don't need persisting anyway.
        if (this.accounts[account.index] === account) {
          await this._onTokenRefresh?.(account.index, newTokens, previousTokens);
        }
      } catch (err) {
        console.error(`[TeamClaude] Token refresh failed for "${account.name}": ${err.message}`);
        account._refreshRetryAt = Date.now() + REFRESH_SWEEP_RETRY_MS;
        // Only mark as error if the access token is actually expired;
        // a failed proactive refresh shouldn't kill a still-valid token.
        // Tag the cause only on the transition: a failed sweep must not relabel
        // an account already parked by the request path as refresh-caused.
        if (!account.expiresAt || Date.now() >= normalizeExpiresAt(account.expiresAt)) {
          if (account.status !== 'error') {
            account.status = 'error';
            account._errorFromRefresh = true;
          }
        }
      } finally {
        account._refreshPromise = null;
      }
    })();

    return account._refreshPromise;
  }

  /**
   * Keep idle OAuth refresh chains alive and retry refresh-caused failures.
   * Disabled accounts are included because disable only removes them from
   * routing; refreshes are sequential and overlapping sweeps are skipped so a
   * fleet-wide lapse cannot burst the token endpoint.
   */
  async refreshLapsedTokens() {
    if (this._sweepInFlight) return 0;
    this._sweepInFlight = true;
    try {
      const now = Date.now();
      const targets = this.accounts.filter(a =>
        a.type === 'oauth' && a.refreshToken
        && (!a._refreshRetryAt || now >= a._refreshRetryAt)
        && (a.status === 'error' || isTokenExpiringSoon(a.expiresAt)));
      for (const account of targets) {
        // A still-valid error account is a no-op unless expiry is unknown.
        // This avoids rotating a request-rejected account every sweep.
        await this.ensureTokenFresh(account, account.status === 'error' && !account.expiresAt)
          .catch(() => { /* keep the account parked until a later sweep succeeds */ });
      }
      return targets.length;
    } finally {
      this._sweepInFlight = false;
    }
  }

  /**
   * Set a callback to persist refreshed tokens to config.
   */
  onTokenRefresh(callback) {
    this._onTokenRefresh = callback;
  }

  onAccountFlag(callback) {
    this._onAccountFlag = callback;
  }

  setSubscriptionDisabled(ref, disabled, persist = true) {
    const account = this._resolveRef(ref);
    if (!account || account.provider !== 'anthropic') return null;
    const next = disabled === true;
    const previous = account.subscriptionDisabled === true;
    if (next) {
      account.subscriptionDisabled = true;
      account.status = 'error';
      account.errorReason = 'subscription-disabled';
      account._errorFromRefresh = false;
    } else {
      delete account.subscriptionDisabled;
      if (account.status === 'error' && account.errorReason === 'subscription-disabled') {
        account.status = 'active';
        delete account.errorReason;
        delete account._errorFromRefresh;
        this._drainWaiters();
      }
    }
    if (persist && previous !== next && this.accounts[account.index] === account) {
      this._onAccountFlag?.(account, next);
    }
    return account;
  }

  /**
   * Update a specific account's OAuth tokens (e.g. after intercepting a token refresh).
   */
  updateAccountTokens(accountIndex, {
    accessToken,
    refreshToken,
    expiresAt,
    idToken,
    accountId,
  }, persist = true) {
    const account = this._resolve(accountIndex);
    if (!account || account.type !== 'oauth') return;

    const previousTokens = {
      accessToken: account.credential,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    };
    account.credential = accessToken;
    if (refreshToken) account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
    if (idToken) account.idToken = idToken;
    if (accountId) {
      account.accountId = accountId;
      account.accountUuid = accountId;
    }
    if (account.subscriptionDisabled === true) {
      this.setSubscriptionDisabled(account, false, persist);
    }
    if (account.status === 'error') {
      account.status = 'active';
      delete account._errorFromRefresh;
    }
    delete account._refreshRetryAt;
    console.log(`[TeamClaude] Updated tokens for account "${account.name}"`);
    // Same liveness guard as ensureTokenFresh: never emit a stale index for a
    // removed account (here the path is synchronous, but keep the invariant uniform).
    if (persist && this.accounts[account.index] === account) this._onTokenRefresh?.(account.index, {
      accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
      idToken: account.idToken,
      accountId: account.accountId,
    }, previousTokens);
  }

  /**
   * Add a new account at runtime.
   */
  addAccount(acctData) {
    const index = this.accounts.length;
    this.accounts.push({
      index,
      name: acctData.name,
      type: acctData.type,
      provider: acctData.provider || 'anthropic',
      accountUuid: acctData.accountUuid || null,
      credential: acctData.accessToken || acctData.apiKey,
      refreshToken: acctData.refreshToken || null,
      idToken: acctData.idToken || null,
      accountId: acctData.accountId || null,
      expiresAt: acctData.expiresAt || null,
      status: acctData.subscriptionDisabled === true
          && (acctData.provider || 'anthropic') === 'anthropic'
        ? 'error' : 'active',
      subscriptionDisabled: acctData.subscriptionDisabled === true
          && (acctData.provider || 'anthropic') === 'anthropic'
        ? true : undefined,
      errorReason: acctData.subscriptionDisabled === true
          && (acctData.provider || 'anthropic') === 'anthropic'
        ? 'subscription-disabled' : undefined,
      _errorFromRefresh: acctData.subscriptionDisabled === true
          && (acctData.provider || 'anthropic') === 'anthropic'
        ? false : undefined,
      enabled: acctData.enabled !== false,
      priority: Number.isFinite(acctData.priority) ? Math.floor(acctData.priority) : null,
      quota: emptyQuota(),
      usage: { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastUsed: null },
      rateLimitedUntil: null,
      inflight: 0,
      maxConcurrent: coerceMaxConcurrent(acctData.maxConcurrent, this.maxConcurrentDefault),
    });
    // The new account has free capacity — hand it to any request waiting in the
    // overflow queue instead of letting it time out to a 429 while a usable
    // account sits idle.
    this._drainWaiters();
    return index;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index) {
    if (index < 0 || index >= this.accounts.length) return;
    this.accounts.splice(index, 1);
    this.accounts.forEach((a, i) => a.index = i);
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = Math.max(0, this.accounts.length - 1);
    } else if (this.currentIndex > index) {
      this.currentIndex--;
    }
  }

  /**
   * Resolve a caller-facing account reference — an account object or a name
   * string — to the live account object (or null). Used by the public
   * setEnabled/setPriority.
   *
   * A bare numeric index is intentionally NOT accepted here (unlike the internal
   * `_resolve`): a setter is a mutation, and an index captured before a
   * removeAccount() re-index would silently disable/reprioritize whatever account
   * shifted into that slot. Callers pass the account object (TUI / sync) or its
   * name (CLI) — both survive a re-index.
   */
  _resolveRef(ref) {
    if (typeof ref === 'string') return this.accounts.find(a => a.name === ref) || null;
    if (ref && typeof ref === 'object') return this.accounts.includes(ref) ? ref : null;
    return null;
  }

  /**
   * Enable or disable an account at runtime. A disabled account is excluded from
   * rotation (via _isAvailable) but keeps any in-flight requests until they
   * finish. Re-enabling hands its now-free capacity to any queued waiters.
   * Returns the affected account, or null if `ref` matched nothing.
   */
  setEnabled(ref, enabled) {
    const account = this._resolveRef(ref);
    if (!account) return null;
    account.enabled = enabled !== false;
    // Re-evaluate the overflow queue either way: re-enabling hands the account's
    // free slots to waiters; disabling may leave a waiter that could *only* be
    // served by this account with no hope — _drainWaiters settles those now (so
    // they release their finite queue slot) instead of stranding them to timeout.
    this._drainWaiters();
    this._reprioritize();
    return account;
  }

  /**
   * Set (or clear) an account's explicit selection priority. Lower number =
   * preferred first; pass null/undefined/NaN to clear it (back to use-or-lose).
   * Returns the affected account, or null if `ref` matched nothing.
   */
  setPriority(ref, priority) {
    const account = this._resolveRef(ref);
    if (!account) return null;
    account.priority = Number.isFinite(priority) ? Math.floor(priority) : null;
    this._reprioritize();
    return account;
  }

  /**
   * A preference change (enable/disable/priority) should take effect promptly,
   * not wait out the sticky `reevalIntervalMs` window (and not at all when the
   * timer is off). Re-pick the active account *directly* here — in either mode —
   * but ONLY when it actually matters: the current account is no longer usable
   * (e.g. just disabled), or a strictly higher-priority account is available.
   *
   * A no-op change (or one that doesn't dethrone the current account) leaves the
   * sticky primary untouched, so it can't churn cache locality. We deliberately
   * do NOT reset `lastEvalAt` to 0 — that would wake the periodic timer re-eval,
   * whose tie round-robin would switch the primary even when nothing changed.
   */
  _reprioritize() {
    const current = this.accounts[this.currentIndex];
    const best = this._selectBest();
    if (!best || best.index === this.currentIndex) return;
    // Switch only when `best` is *strictly* preferred over the current account by
    // the full selection order (priority → soonest reset → least used), or the
    // current account is unusable. Comparing the full order — not priority alone —
    // means clearing a priority correctly restores use-or-lose routing, while a
    // true tie (best ranks equal to current) still leaves the sticky primary put
    // so there's no cache-churn.
    if (this._isAvailable(current) && !this._strictlyPrefer(best, current)) return;
    this.currentIndex = best.index;
    this.lastEvalAt = Date.now(); // just evaluated — don't also trigger a timer re-eval
  }

  /**
   * Is account `a` strictly preferred over `b` by the same lexicographic order
   * `_selectBest` sorts on: explicit priority (lower first), then soonest weekly
   * reset, then soonest session reset, then lowest utilization. Returns false
   * when they rank equal (a tie).
   */
  _strictlyPrefer(a, b) {
    const pa = this._priority(a), pb = this._priority(b);
    if (pa !== pb) return pa < pb;
    const wa = this._weeklyResetTime(a), wb = this._weeklyResetTime(b);
    if (wa !== wb) return wa < wb;
    const ra = this._sessionResetTime(a), rb = this._sessionResetTime(b);
    if (ra !== rb) return ra < rb;
    return this._sessionUtilization(a) < this._sessionUtilization(b);
  }

  /**
   * Snapshot of general per-account quota state for persistence across restarts
   * (credential-free). Quota lives only in memory otherwise, so a restart used
   * to blank the whole dashboard (and blind use-or-lose ordering) until traffic
   * organically re-measured every account.
   */
  exportQuotaState() {
    return this.accounts.map(a => ({
      accountUuid: a.accountUuid || null,
      name: a.name,
      quota: {
        ...a.quota,
        modelWeekly: {},
      },
      rateLimitedUntil: a.rateLimitedUntil,
      usage: { ...a.usage },
    }));
  }

  /**
   * Restore a quota snapshot from a previous run. A snapshot entry WITH an
   * accountUuid is matched by uuid ONLY — a same-name account with a different
   * uuid is a *replaced* account (a different underlying identity), and
   * restoring the old quota/throttle onto it would falsely mark a fresh
   * account near-quota or throttled. Name matching is the fallback solely for
   * entries without a uuid (API-key accounts, whose identity key is the name).
   * Unknown entries are skipped (→ unmeasured, exactly the pre-restore state).
   * Values may be slightly stale, but the proxy takes no traffic while it's
   * down, and expired windows are lazily swept by _isNearQuota on first use —
   * so a restore is strictly better than starting blind. A still-future
   * rateLimitedUntil re-throttles the account; error/exhausted statuses are
   * deliberately NOT restored (a bad token may have been fixed since).
   */
  importQuotaState(saved) {
    for (const s of Array.isArray(saved) ? saved : []) {
      if (!s || typeof s !== 'object') continue;
      const a = s.accountUuid
        ? this.accounts.find(x => x.accountUuid === s.accountUuid)
        : this.accounts.find(x => x.name === s.name);
      if (!a) continue;
      if (s.quota && typeof s.quota === 'object') {
        // Merge over emptyQuota so a cache written by an older version (missing
        // newer fields like modelWeekly) still yields a complete quota object.
        a.quota = {
          ...emptyQuota(),
          ...s.quota,
          // unifiedStatus is a PER-RESPONSE signal — isExhausted() treats a
          // 'rejected' here as "this 429 is account exhaustion". Restoring a
          // stale one would misclassify a later transient/headerless 429 as
          // exhaustion and wrongly throttle the account. Only a live response
          // (updateQuota) may set it.
          unifiedStatus: null,
          // A model-scoped value is only observable on responses for that tier.
          // Restoring it can pre-empt the very request needed to refresh it, so
          // always re-measure model windows after a restart.
          modelWeekly: {},
        };
      }
      if (s.usage && typeof s.usage === 'object') a.usage = { ...a.usage, ...s.usage };
      if (Number.isFinite(s.rateLimitedUntil) && s.rateLimitedUntil > Date.now()) {
        a.rateLimitedUntil = s.rateLimitedUntil;
        a.status = 'throttled';
      }
    }
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      currentAccountUuid: this.accounts[this.currentIndex]?.accountUuid || null,
      switchThreshold: this.switchThreshold,
      accounts: this.accounts.map(a => ({
        name: a.name,
        accountUuid: a.accountUuid || null,
        type: a.type,
        provider: a.provider,
        status: a.status,
        errorReason: a.status === 'error' ? (a.errorReason ?? null) : null,
        enabled: a.enabled !== false,
        priority: a.priority ?? null,
        // Deep-copy the nested modelWeekly map — the shallow quota spread would
        // otherwise hand callers a live reference into account state.
        quota: {
          ...a.quota,
          modelWeekly: Object.fromEntries(
            Object.entries(a.quota.modelWeekly).map(([k, w]) => [k, { ...w }])),
        },
        usage: { ...a.usage },
        inflight: a.inflight,
        maxConcurrent: a.maxConcurrent,
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
    };
  }
}
