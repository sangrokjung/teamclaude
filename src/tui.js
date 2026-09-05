import { importCredentials, fetchProfile, loginOAuth } from './oauth.js';
import { importCodexCredentials } from './codex.js';
import { importGrokCredentials, importAgyCredentials } from './provider-oauth.js';
import { providerDefaultPort } from './provider-config.js';
import { createHostTracker } from './system-metrics.js';

// ── ANSI helpers ─────────────────────────────────────────────

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'.split('');
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

const bold = s => `${BOLD}${s}${RESET}`;
const dim = s => `${DIM}${s}${RESET}`;
const fg = (c, s) => `${ESC}${c}m${s}${RESET}`;
const green = s => fg(32, s);
const yellow = s => fg(33, s);
const red = s => fg(31, s);
const cyan = s => fg(36, s);
const gray = s => fg(90, s);

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = s => s.replace(ANSI_RE, '');
const vw = s => strip(s).length;

function rpad(s, w) {
  const gap = w - vw(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/** Truncate a string with ANSI codes to exactly w visible characters, then reset. */
function truncate(s, w) {
  let visible = 0;
  let out = '';
  let i = 0;
  while (i < s.length && visible < w) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end >= 0) { out += s.slice(i, end + 1); i = end + 1; continue; }
    }
    out += s[i];
    visible++;
    i++;
  }
  return out + RESET;
}

/** Fit a line to exactly w columns: truncate if too long, pad if too short. */
function fitLine(s, w) {
  const v = vw(s);
  if (v > w) return truncate(s, w);
  if (v < w) return s + ' '.repeat(w - v);
  return s;
}

function formatReset(resetTs) {
  if (!resetTs) return '';
  const ms = resetTs - Date.now();
  if (ms <= 0) return '';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 24) return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `${days}d${rh}h` : `${days}d`;
}

/**
 * Render a progress bar using background colors with text overlaid.
 * The label (e.g. "Ses 2h30m" or "45%") is drawn on top of the bar.
 */
function bar(ratio, w = 10, resetTs) {
  const rst = formatReset(resetTs);

  if (ratio == null || isNaN(ratio)) {
    // No data — dim background, show label or dash
    const label = rst || '-';
    const text = label.slice(0, w);
    const pad = w - text.length;
    const lp = Math.floor(pad / 2);
    const rp = pad - lp;
    return `${ESC}100m${' '.repeat(lp)}${text}${' '.repeat(rp)}${RESET}`;
  }

  ratio = Math.max(0, Math.min(1, ratio));
  const f = Math.round(ratio * w);
  // Background colors: 42=green, 43=yellow, 41=red; 100=bright black (gray) for empty
  const bg = ratio < 0.7 ? 42 : ratio < 0.9 ? 43 : 41;

  // Always show usage %, and append the reset countdown when it fits.
  const pct = (ratio * 100).toFixed(0) + '%';
  const label = (rst && pct.length + 1 + rst.length <= w) ? `${pct} ${rst}` : pct;
  const text = label.slice(0, w);
  const pad = w - text.length;
  const lp = Math.floor(pad / 2);
  const rp = pad - lp;
  const chars = (' '.repeat(lp) + text + ' '.repeat(rp));

  // Split chars into filled (colored bg) and empty (gray bg) portions
  const filled = chars.slice(0, f);
  const empty = chars.slice(f);

  let out = '';
  if (filled) out += `${ESC}${bg};97m${filled}`;
  if (empty) out += `${ESC}100;37m${empty}`;
  out += RESET;
  return out;
}

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

function sameAccountIdentity(a, b) {
  if (a.accountUuid && b.accountUuid) return a.accountUuid === b.accountUuid;
  return a.name === b.name;
}

function findAccountByIdentity(accounts, account) {
  return accounts.find(candidate => sameAccountIdentity(candidate, account));
}

function authTimestamp(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0;
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function hasVerifiedAuthProof(stored, live, allowLegacyReauth = false) {
  const verifiedAt = authTimestamp(stored?.authVerifiedAt);
  const storedUuid = stored?.accountUuid || null;
  if (!verifiedAt || !stored?.accessToken || !stored?.refreshToken
      || !['reauth', 'import', 'login'].includes(stored.source)) return false;
  const liveUuid = live?.accountUuid || null;
  // Imports/logins must prove the same stable UUID on both sides. A legacy
  // row has no identity to compare, so it cannot be revived by a same-name
  // credential; the explicit reauth flow writes the UUID before this merge.
  const explicitLegacyReauth = allowLegacyReauth
    && stored.source === 'reauth'
    && storedUuid
    && !liveUuid
    && typeof stored.name === 'string'
    && typeof live?.name === 'string'
    && stored.name.toLowerCase() === live.name.toLowerCase();
  if ((!storedUuid || !liveUuid || storedUuid !== liveUuid) && !explicitLegacyReauth) return false;
  if ((stored.authVerifiedAccountUuid || null) !== storedUuid) return false;
  // Never let an absent/malformed revocation timestamp turn an unknown
  // quarantine age into a zero floor.
  if (stored.authRevoked === true && !authTimestamp(stored.authRevokedAt)) return false;
  if (live?.authRevoked === true && !authTimestamp(live.authRevokedAt)) return false;
  return verifiedAt > Math.max(
    authTimestamp(live?.authRevokedAt),
    authTimestamp(stored.authRevokedAt),
  );
}

function mergeAuthState(existing, incoming) {
  const merged = { ...existing, ...incoming };
  const incomingProof = hasVerifiedAuthProof(incoming, existing, incoming.source === 'reauth');
  const existingProof = hasVerifiedAuthProof(existing, existing);
  if (existingProof && !incomingProof) {
    for (const field of ['authRevoked', 'authRevokedAt', 'authVerifiedAt', 'authVerifiedAccountUuid', 'source']) {
      if (existing[field] === undefined) delete merged[field];
      else merged[field] = existing[field];
    }
  } else if (existing.authRevoked === true && !incomingProof) {
    // A quarantined row keeps its credential/identity payload until an
    // independently verified proof arrives. Merging a different UUID here
    // would still install the wrong token even if the marker itself survived.
    for (const field of [
      'name', 'type', 'provider', 'accountUuid', 'accessToken', 'refreshToken',
      'expiresAt', 'idToken', 'accountId', 'email', 'oauthIssuer', 'oauthClientId',
      'authMethod', 'projectId', 'oauthTokenEndpoint', 'source',
      'authVerifiedAt', 'authVerifiedAccountUuid', 'importFrom',
    ]) {
      if (existing[field] === undefined) delete merged[field];
      else merged[field] = existing[field];
    }
    merged.authRevoked = true;
    merged.authRevokedAt = Math.max(
      authTimestamp(existing.authRevokedAt),
      authTimestamp(incoming.authRevokedAt),
    ) || existing.authRevokedAt || incoming.authRevokedAt;
  }
  return merged;
}

function applyClearFields(account, fields, existing = null) {
  const proofClearsQuarantine = existing?.authRevoked !== true
    || hasVerifiedAuthProof(account, existing, account?.source === 'reauth');
  for (const field of fields || []) {
    if (!proofClearsQuarantine
        && (field === 'authRevoked' || field === 'authRevokedAt' || field === 'importFrom')) continue;
    delete account[field];
  }
}

function persistedAccount(snapshot, accountManager, account) {
  const configAccount = findAccountByIdentity(snapshot.accounts, account) || account;
  const liveAccount = findAccountByIdentity(accountManager.accounts, configAccount);
  if (!liveAccount) return configAccount;
  return {
    ...configAccount,
    accessToken: liveAccount.credential,
    refreshToken: liveAccount.refreshToken,
    expiresAt: liveAccount.expiresAt,
    idToken: liveAccount.idToken,
    accountId: liveAccount.accountId,
  };
}

function patchAccount(accounts, account, fields) {
  const target = findAccountByIdentity(accounts, account);
  if (!target) return;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) delete target[key];
    else target[key] = value;
  }
}

export function applyTuiAccountMutation(diskConfig, snapshot, accountManager, mutation) {
  if (mutation.type === 'upsert') {
    const previous = mutation.previous
      ? findAccountByIdentity(diskConfig.accounts, mutation.previous)
      : null;
    if (mutation.previous && !previous) return;
    const account = persistedAccount(snapshot, accountManager, mutation.account);
    const current = findAccountByIdentity(diskConfig.accounts, account);
    const existing = previous || current;
    if (existing) {
      const merged = mergeAuthState(existing, account);
      applyClearFields(merged, mutation.clearFields, existing);
      diskConfig.accounts[diskConfig.accounts.indexOf(existing)] = merged;
    } else {
      const created = { ...account };
      applyClearFields(created, mutation.clearFields);
      diskConfig.accounts.push(created);
    }
    return;
  }
  if (mutation.type === 'remove') {
    const existing = findAccountByIdentity(diskConfig.accounts, mutation.account);
    if (existing) diskConfig.accounts.splice(diskConfig.accounts.indexOf(existing), 1);
    return;
  }
  if (mutation.type === 'patch') {
    patchAccount(diskConfig.accounts, mutation.account, mutation.fields);
    return;
  }
  if (mutation.type === 'batchPatch') {
    for (const patch of mutation.patches) {
      patchAccount(diskConfig.accounts, patch.account, patch.fields);
    }
    return;
  }
  throw new Error(`Unknown TUI account mutation: ${mutation.type}`);
}

// ── TUI class ────────────────────────────────────────────────

export class TUI {
  constructor({ accountManager, config, saveConfig, syncAccounts, refreshQuota, reauthenticate, importCredentials: importAnthropicCredentials, fetchProfile: fetchAnthropicProfile, importProviderCredentials, onQuit }) {
    this.am = accountManager;
    this.config = config;
    this.saveConfig = saveConfig;
    this.syncAccounts = syncAccounts;
    this.refreshQuota = refreshQuota;  // optional: forced fleet quota re-measure (R)
    this.importAnthropicCredentials = importAnthropicCredentials || importCredentials;
    this.fetchAnthropicProfile = fetchAnthropicProfile || fetchProfile;
    this.importProviderCredentials = importProviderCredentials || (() => {
      if (config?.provider === 'grok') return importGrokCredentials();
      if (config?.provider === 'agy') return importAgyCredentials();
      return null;
    });
    this.reauthenticate = reauthenticate || (async () => {
      const credentials = await loginOAuth();
      const profile = await this.fetchAnthropicProfile(credentials.accessToken);
      return { credentials, profile };
    });
    this.onQuit = onQuit;
    this._host = createHostTracker(); // host CPU/RAM shown in the header

    this.log = [];           // completed activity entries
    this.active = new Map(); // in-flight requests
    this.mode = 'normal';    // normal | select (delete-confirm) | add | input | order
    this.selIdx = 0;         // cursor POSITION over the display list (render hint)
    this.selAcct = null;     // cursor ANCHOR: the selected account OBJECT (see _selected)
    this.orderAccount = null; // the account being moved while in 'order' mode
    this.inputPrompt = '';
    this.inputBuf = '';
    this.inputCb = null;
    this.frame = 0;
    this.running = false;
    this.timer = null;
    this._origLog = null;
    this._origErr = null;
    this._reauthPromise = null;
  }

  // ── lifecycle ──────────────────────────────────────

  start() {
    this.running = true;
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    this._dataHandler = d => this._onData(d);
    this._resizeHandler = () => this.render();
    process.stdin.on('data', this._dataHandler);
    process.stdout.on('resize', this._resizeHandler);

    // Redirect console to activity log
    this._origLog = console.log;
    this._origErr = console.error;
    console.log = (...a) => this._addLog(a.join(' '));
    console.error = (...a) => this._addLog(a.join(' '));

    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.render();
    }, 500);
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._origLog) { console.log = this._origLog; console.error = this._origErr; }
    process.stdin.removeListener('data', this._dataHandler);
    process.stdout.removeListener('resize', this._resizeHandler);
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
  }

  // ── server hooks ───────────────────────────────────

  onRequestStart(id, info) {
    this.active.set(id, { ...info, t: timestamp(), started: Date.now(), account: null });
    this.render();
  }

  onRequestRouted(id, info) {
    const r = this.active.get(id);
    if (r) r.account = info.account;
  }

  onRequestEnd(id, info) {
    const r = this.active.get(id);
    this.active.delete(id);
    const dur = r ? ((Date.now() - r.started) / 1000).toFixed(1) : '?';
    const acct = info.account || r?.account || '?';
    this._addLog(`${info.method} ${info.path} → ${acct} (${info.status}, ${dur}s)`);
  }

  _addLog(msg) {
    msg = msg.replace(/^\[TeamClaude\]\s*/, '');
    this.log.unshift({ t: timestamp(), msg });
    if (this.log.length > 200) this.log.length = 200;
    if (this.running) this.render();
  }

  // ── input handling ─────────────────────────────────

  _onData(d) {
    if (d === '\x1b[A') return this._key('up');
    if (d === '\x1b[B') return this._key('down');
    if (d === '\x1b') return this._key('esc');
    if (d === '\r' || d === '\n') return this._key('enter');
    if (d === '\x03') return this._key('ctrl-c');
    if (d === '\x7f' || d === '\x08') return this._key('bs');
    if (d.length === 1 && d >= ' ') return this._key(d);
  }

  _key(k) {
    if (k === 'ctrl-c') { this.stop(); this.onQuit?.(); return; }

    switch (this.mode) {
      case 'normal': this._keyNormal(k); break;
      case 'select': this._keySelect(k); break;
      case 'add':    this._keyAdd(k); break;
      case 'input':  this._keyInput(k); break;
      case 'order':  this._keyOrder(k); break;
    }
    this.render();
  }

  /**
   * The cursor-selected ACCOUNT OBJECT. The display list re-sorts live — the
   * auto group follows quota data, which background responses/probes update at
   * any time — so a bare display index is racy: the row under the cursor can
   * become a *different account* between two keypresses. Anchoring the
   * selection on the object means a reorder moves the highlight with the
   * account and can never retarget a pending action (notably delete) onto a
   * neighbor. Falls back to the remembered position when the anchored account
   * is gone (deleted / synced away), and keeps `selIdx` synced for rendering.
   */
  _selected() {
    const list = this._displayList();
    if (list.length === 0) { this.selAcct = null; return null; }
    if (this.selAcct) {
      const pos = list.indexOf(this.selAcct);
      if (pos >= 0) { this.selIdx = pos; return this.selAcct; }
    }
    this.selIdx = Math.min(Math.max(0, this.selIdx), list.length - 1);
    this.selAcct = list[this.selIdx];
    return this.selAcct;
  }

  /** Move the cursor by dir (±1) over the CURRENT display order, re-anchoring the object. */
  _moveSel(dir) {
    const list = this._displayList();
    if (list.length === 0) return;
    this._selected(); // sync selIdx to the anchored account's current position
    this.selIdx = Math.min(Math.max(0, this.selIdx + dir), list.length - 1);
    this.selAcct = list[this.selIdx];
  }

  _keyNormal(k) {
    if (k === 'q') { this.stop(); this.onQuit?.(); return; }
    if (k === 'a') { this.mode = 'add'; return; }
    if (k === 'R') { this._doSync(); return; }

    if (this.am.accounts.length === 0) return;

    // ↑/↓ (or k/j) move a selection cursor over the account list right here in the
    // default view — no need to enter a sub-mode first.
    if (k === 'up' || k === 'k') this._moveSel(-1);
    else if (k === 'down' || k === 'j') this._moveSel(+1);
    // The action keys act DIRECTLY on the cursor-selected account (object-anchored).
    else if (k === 's') { const a = this._selected(); if (a) { this.am.currentIndex = a.index; this._addLog(`Switched to "${a.name}"`); } }
    else if (k === 'e') { const a = this._selected(); if (a) this._doToggleEnabled(a.index); }
    else if (k === 'o') { const a = this._selected(); if (a) { this.orderAccount = a; this.mode = 'order'; } }
    else if (k === 'r') { const a = this._selected(); if (this._canReauthenticate(a)) this._doReauthenticate(a); }
    // Delete keeps an explicit confirmation (it's destructive): the cursor account
    // is pre-selected (anchored) and Enter in select mode confirms.
    else if (k === 'd') { this._selected(); this.mode = 'select'; }
  }

  // Select mode is now the DELETE confirmation only — switch / enable-disable /
  // order act directly on the normal-mode ↑/↓ cursor. Here ↑/↓ let you re-pick
  // before confirming; Enter deletes the selected account, Esc cancels.
  _keySelect(k) {
    if (k === 'up' || k === 'k') this._moveSel(-1);
    else if (k === 'down' || k === 'j') this._moveSel(+1);
    else if (k === 'enter') {
      // Act on the ANCHORED account object, resolved to its live array index at
      // action time (reindex-safe, and immune to a display reorder that happened
      // after the cursor was placed).
      const acct = this._selected();
      if (acct) this._doRemove(this.am.accounts.indexOf(acct));
      this.mode = 'normal';
    }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  _keyOrder(k) {
    if (!this.orderAccount || !this.am.accounts.includes(this.orderAccount)) {
      this.mode = 'normal'; this.orderAccount = null; return;
    }
    if (k === 'up' || k === 'k') {
      this._moveOrder(this.orderAccount, -1); // sync mutate; save is coalesced inside
      this._followOrderAccount();
    } else if (k === 'down' || k === 'j') {
      this._moveOrder(this.orderAccount, +1);
      this._followOrderAccount();
    } else if (k === 'a') {
      // Auto: reset the ENTIRE order — every rank is cleared and the whole
      // fleet returns to automatic use-or-lose routing (weekly reset soonest
      // drained first). The list re-sorts to that drain order immediately.
      this._applyRanking([]);
      this._addLog('Order reset: all accounts on auto (weekly-reset order)');
      this._followOrderAccount();
    } else if (k === 'c') {
      // Clear: un-rank just the grabbed account (one keypress instead of moving
      // it down past the bottom of the ranked group).
      this._setAutoOrder(this.orderAccount);
      this._followOrderAccount();
    } else if (k === 'enter' || k === 'esc' || k === 'q') {
      this.mode = 'normal'; this.orderAccount = null;
    }
  }

  /** Keep the cursor anchored on the account being ordered as the list re-sorts. */
  _followOrderAccount() {
    this.selAcct = this.orderAccount;
    this.selIdx = Math.max(0, this._displayList().indexOf(this.orderAccount));
  }

  _keyAdd(k) {
    if (k === 'i') { this._doImport(); this.mode = 'normal'; }
    else if (k === 'k' && (this.config.provider === 'grok' || this.config.provider === 'agy')) {
      this._addLog(`${this.config.provider} subscription accounts use OAuth; API keys are not supported`);
    }
    else if (k === 'k' && this.config.provider !== 'codex') {
      this.mode = 'input';
      this.inputPrompt = 'API key';
      this.inputBuf = '';
      this.inputCb = v => { if (v) this._doAddKey(v); };
    }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  _keyInput(k) {
    if (k === 'enter') {
      const cb = this.inputCb;
      const v = this.inputBuf;
      this.mode = 'normal'; this.inputCb = null; this.inputBuf = '';
      cb?.(v);
    }
    else if (k === 'esc') { this.mode = 'normal'; this.inputCb = null; this.inputBuf = ''; }
    else if (k === 'bs') { this.inputBuf = this.inputBuf.slice(0, -1); }
    else if (k.length === 1) { this.inputBuf += k; }
  }

  // ── account operations ─────────────────────────────

  async _doSync() {
    try {
      const count = await this.syncAccounts();
      if (count > 0) {
        this._addLog(`Synced ${count} new account(s) from config`);
      } else {
        this._addLog('Config reloaded, credentials refreshed');
      }
    } catch (e) {
      this._addLog(`Sync failed: ${e.message}`);
    }
    // Reload also re-measures the WHOLE fleet's quota, not just the account
    // list: the displayed usage drifts silently (spend from other devices or
    // sessions never flows through this proxy), so R doubles as a "give me
    // fresh numbers now" action. Runs after the config sync so probes use any
    // just-refreshed credentials.
    if (this.refreshQuota) {
      try {
        this._addLog('Re-measuring quota for all accounts...');
        const r = await this.refreshQuota();
        if (r === -1 || r == null) {
          this._addLog('Quota refresh skipped — no request has flowed through the proxy yet');
        } else if (r.measured === r.targets) {
          this._addLog(`Quota re-measured for all ${r.measured} account(s)`);
        } else {
          // Honest partial result — some probes were skipped (expired token
          // that would not refresh, auth error) or failed. Never report a
          // blanket success while accounts silently kept stale numbers.
          this._addLog(`Quota re-measured for ${r.measured}/${r.targets} account(s) — the rest failed or were skipped`);
        }
      } catch (e) {
        this._addLog(`Quota refresh failed: ${e.message}`);
      }
    }
  }

  _canReauthenticate(account) {
    return Boolean(account
      && account.type === 'oauth'
      && (!account.provider || account.provider === 'anthropic')
      && account.enabled !== false
      && account.status === 'error'
      && account.errorReason !== 'subscription-disabled'
      && !account._reauthenticating);
  }

  _doReauthenticate(account) {
    if (!this._canReauthenticate(account) || this._reauthPromise) return this._reauthPromise;
    const wasRunning = this.running;
    const previousLive = {
      credential: account.credential,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
      accountUuid: account.accountUuid,
      status: account.status,
      errorReason: account.errorReason,
      errorFromRefresh: account._errorFromRefresh,
      refreshRetryAt: account._refreshRetryAt,
      authRevoked: account.authRevoked,
      authRevokedAt: account.authRevokedAt,
      authVerifiedAt: account.authVerifiedAt,
      authVerifiedAccountUuid: account.authVerifiedAccountUuid,
    };
    const configAccount = account.accountUuid
      ? this.config.accounts.find(a => a.accountUuid === account.accountUuid)
      : this.config.accounts.find(a => a.name === account.name);
    const previousConfig = configAccount ? { ...configAccount } : null;
    const pinnedUuid = account.accountUuid || null;
    let currentConfigAccount = null;

    account._reauthenticating = true;
    this._addLog(`Re-authentication required for "${account.name}" — opening browser...`);

    const run = async () => {
      if (wasRunning) this.stop();
      try {
        const result = await this.reauthenticate(account);
        const credentials = result?.credentials || result;
        const profile = result?.profile;
        if (!credentials?.accessToken || !credentials?.refreshToken || credentials.expiresAt == null) {
          throw new Error('OAuth login returned incomplete credentials');
        }
        if (!profile || profile.error) {
          throw new Error(`could not verify the logged-in account${profile?.error ? `: ${profile.error}` : ''}`);
        }
        const sameUuid = Boolean(account.accountUuid && profile.accountUuid
          && account.accountUuid === profile.accountUuid);
        const sameEmail = !account.accountUuid && account.name && profile.email
          && account.name.toLowerCase() === profile.email.toLowerCase();
        if (!sameUuid && !sameEmail) {
          throw new Error(`logged-in account does not match "${account.name}"`);
        }
        currentConfigAccount = pinnedUuid
          ? this.config.accounts.find(a => a.accountUuid === pinnedUuid)
          : this.config.accounts.find(a => a.name === account.name);
        if (!currentConfigAccount
            || (pinnedUuid && currentConfigAccount.name !== account.name)
            || !this.am.accounts.includes(account)) {
          throw new Error('selected account changed while re-authentication was in progress');
        }
        const newUuid = profile.accountUuid || account.accountUuid;
        const authVerifiedAt = Date.now();
        if (currentConfigAccount) {
          Object.assign(currentConfigAccount, {
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            expiresAt: credentials.expiresAt,
            accountUuid: newUuid,
            source: 'reauth',
            authVerifiedAt,
            authVerifiedAccountUuid: newUuid || null,
          });
          delete currentConfigAccount.authRevoked;
          delete currentConfigAccount.authRevokedAt;
          delete currentConfigAccount.importFrom;
        }

        this.am.updateAccountTokens(account, {
          accessToken: credentials.accessToken,
          refreshToken: credentials.refreshToken,
          expiresAt: credentials.expiresAt,
        }, false);
        account.accountUuid = newUuid;
        account.authVerifiedAt = authVerifiedAt;
        account.authVerifiedAccountUuid = newUuid || null;
        const savedConfig = await this.saveConfig(this.config, {
          type: 'upsert',
          account: {
            name: account.name,
            type: account.type,
            source: 'reauth',
            accountUuid: newUuid,
            accessToken: credentials.accessToken,
            refreshToken: credentials.refreshToken,
            expiresAt: credentials.expiresAt,
            authVerifiedAt,
            authVerifiedAccountUuid: newUuid || null,
          },
          previous: previousConfig,
          clearFields: ['authRevoked', 'authRevokedAt', 'importFrom'],
        });
        if (!Array.isArray(savedConfig?.accounts)) {
          throw new Error('re-authenticated account persistence could not be verified');
        }
        const persisted = findAccountByIdentity(savedConfig.accounts, {
          name: account.name,
          accountUuid: newUuid,
        });
        if (!persisted
            || persisted.accessToken !== credentials.accessToken
            || persisted.refreshToken !== credentials.refreshToken
            || persisted.expiresAt !== credentials.expiresAt
            || persisted.authRevoked === true
            || persisted.authRevokedAt != null
            || persisted.importFrom != null
            || persisted.authVerifiedAt !== authVerifiedAt
            || persisted.authVerifiedAccountUuid !== (newUuid || null)) {
          throw new Error('re-authenticated account was not persisted');
        }
        this._addLog(`Re-authenticated "${account.name}" successfully`);
      } catch (e) {
        account.credential = previousLive.credential;
        account.accessToken = previousLive.accessToken;
        account.refreshToken = previousLive.refreshToken;
        account.expiresAt = previousLive.expiresAt;
        account.accountUuid = previousLive.accountUuid;
        account.status = previousLive.status;
        if (previousLive.errorReason === undefined) delete account.errorReason;
        else account.errorReason = previousLive.errorReason;
        if (previousLive.errorFromRefresh === undefined) delete account._errorFromRefresh;
        else account._errorFromRefresh = previousLive.errorFromRefresh;
        if (previousLive.refreshRetryAt === undefined) delete account._refreshRetryAt;
        else account._refreshRetryAt = previousLive.refreshRetryAt;
        if (previousLive.authRevoked === undefined) delete account.authRevoked;
        else account.authRevoked = previousLive.authRevoked;
        if (previousLive.authRevokedAt === undefined) delete account.authRevokedAt;
        else account.authRevokedAt = previousLive.authRevokedAt;
        if (previousLive.authVerifiedAt === undefined) delete account.authVerifiedAt;
        else account.authVerifiedAt = previousLive.authVerifiedAt;
        if (previousLive.authVerifiedAccountUuid === undefined) delete account.authVerifiedAccountUuid;
        else account.authVerifiedAccountUuid = previousLive.authVerifiedAccountUuid;
        if (currentConfigAccount && previousConfig) {
          Object.keys(currentConfigAccount).forEach(key => delete currentConfigAccount[key]);
          Object.assign(currentConfigAccount, previousConfig);
        }
        this._addLog(`Re-authentication failed for "${account.name}": ${e.message}`);
      } finally {
        delete account._reauthenticating;
        if (wasRunning) this.start();
      }
    };
    this._reauthPromise = run().finally(() => { this._reauthPromise = null; });
    return this._reauthPromise;
  }

  async _doImport() {
    if (this.config.provider === 'codex') {
      await this._doImportCodex();
      return;
    }
    if (this.config.provider === 'grok' || this.config.provider === 'agy') {
      await this._doImportProvider();
      return;
    }
    try {
      this._addLog('Importing credentials...');
      const creds = await this.importAnthropicCredentials('~/.claude/.credentials.json');
      const profile = await this.fetchAnthropicProfile(creds.accessToken);
      const profileOk = profile && !profile.error;

      if (!profileOk) {
        this._addLog(`Warning: could not fetch profile — ${profile?.error || 'no token'}`);
      }

      let name;
      if (profile?.email) {
        name = profile.email;
        const tier = profile.hasClaudeMax ? 'Max' : profile.hasClaudePro ? 'Pro' : null;
        if (tier) this._addLog(`Detected Claude ${tier}: ${name}`);
      } else {
        // Pick the first FREE account-N (not `count + 1`, which collides after a
        // delete, e.g. delete account-1 then the next import reuses account-2).
        let n = 1;
        do { name = `account-${n++}`; } while (this.config.accounts.some(a => a.name === name));
      }

      const entry = {
        name, type: 'oauth', source: 'import',
        accountUuid: profile?.accountUuid || null,
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: creds.expiresAt,
        ...(profileOk && (profile.accountUuid || profile.email) ? {
          authVerifiedAt: Date.now(),
          authVerifiedAccountUuid: profile.accountUuid || null,
        } : {}),
      };

      // Deduplicate: match by UUID first, then by name
      let idx = profile?.accountUuid
        ? this.config.accounts.findIndex(a => a.accountUuid === profile.accountUuid)
        : -1;
      if (idx < 0) idx = this.config.accounts.findIndex(a => a.name === name);
      let previous = null;
      let verifiedReimport = false;

      if (idx >= 0) {
        // Preserve manual routing settings across a re-import (the new entry
        // omits them, so a re-import would otherwise re-enable a disabled
        // account / clear its priority).
        const prev = this.config.accounts[idx];
        previous = prev;
        const amAcct = (prev.accountUuid && this.am.accounts.find(a => a.accountUuid === prev.accountUuid))
          || this.am.accounts.find(a => a.name === prev.name);
        const quarantined = prev.authRevoked === true || amAcct?.authRevoked === true;
        verifiedReimport = quarantined
          ? hasVerifiedAuthProof(entry, prev)
            && (!amAcct || hasVerifiedAuthProof(entry, amAcct))
          : profileOk && (prev.accountUuid
            ? prev.accountUuid === profile.accountUuid
            : Boolean(profile.email && prev.name
              && prev.name.toLowerCase() === profile.email.toLowerCase()));
        if (quarantined && !verifiedReimport) {
          this._addLog(`Import rejected for "${name}" — account is quarantined; use re-authentication`);
          return;
        }
        if (prev.enabled !== undefined) entry.enabled = prev.enabled;
        if (prev.priority !== undefined) entry.priority = prev.priority;
        this.config.accounts[idx] = entry;
        // Update the running account manager entry, matched by IDENTITY (the
        // previous entry's UUID first, then name) — NOT the config index `idx`,
        // which can point at a different live account when a tokenless config entry
        // was skipped at load (config.accounts is not index-aligned with
        // accountManager.accounts).
        if (amAcct) {
          this.am.updateAccountTokens(amAcct, entry, false, {
            clearAuthRevoked: !quarantined || verifiedReimport,
          });
          amAcct.accountUuid = entry.accountUuid;
          amAcct.name = name;
        } else {
          // The matched config entry had no live AccountManager account (it was
          // skipped at load — e.g. previously tokenless). Now that we have fresh
          // credentials, add it so the running server can actually use it.
          this.am.addAccount(entry);
        }
        this._addLog(`Updated account "${name}"`);
      } else {
        this.config.accounts.push(entry);
        this.am.addAccount(entry);
        this._addLog(`Imported account "${name}"`);
      }

      await this.saveConfig(this.config, {
        type: 'upsert',
        account: entry,
          previous,
        clearFields: verifiedReimport ? ['authRevoked', 'authRevokedAt', 'importFrom'] : undefined,
      });
    } catch (e) {
      this._addLog(`Import failed: ${e.message}`);
    }
  }

  async _doImportProvider() {
    const provider = this.config.provider;
    try {
      this._addLog(`Importing ${provider} subscription credentials...`);
      const creds = await this.importProviderCredentials();
      if (!creds?.accessToken || !creds.accountUuid) {
        throw new Error(`${provider} import returned incomplete OAuth credentials`);
      }
      let name = creds.email || `${provider}-${String(creds.accountUuid).slice(0, 8)}`;
      if (this.config.accounts.some(a => a.name === name && a.accountUuid !== creds.accountUuid)) {
        let n = 1;
        do { name = `${provider}-${n++}`; } while (this.config.accounts.some(a => a.name === name));
      }
      const entry = {
        name,
        provider,
        type: 'oauth',
        source: 'import',
        accountUuid: creds.accountUuid,
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken ?? null,
        expiresAt: creds.expiresAt,
      };
      for (const field of [
        'email', 'oauthIssuer', 'oauthClientId', 'authMode', 'authMethod',
        'projectId', 'oauthTokenEndpoint',
      ]) {
        if (creds[field] != null) entry[field] = creds[field];
      }

      const previousIndex = this.config.accounts.findIndex(a =>
        (a.accountUuid && a.accountUuid === entry.accountUuid) || a.name === name);
      const previous = previousIndex >= 0 ? this.config.accounts[previousIndex] : null;
      if (previous?.enabled !== undefined) entry.enabled = previous.enabled;
      if (previous?.priority !== undefined) entry.priority = previous.priority;
      if (previous?.maxConcurrent !== undefined) entry.maxConcurrent = previous.maxConcurrent;

      if (previousIndex >= 0) {
        this.config.accounts[previousIndex] = entry;
        const live = this.am.accounts.find(a =>
          (a.accountUuid && a.accountUuid === entry.accountUuid) || a.name === previous.name);
        if (live) {
          this.am.updateAccountTokens(live, entry);
          live.name = entry.name;
          live.provider = provider;
        } else {
          this.am.addAccount(entry);
        }
        this._addLog(`Updated ${provider} account "${name}"`);
      } else {
        this.config.accounts.push(entry);
        this.am.addAccount(entry);
        this._addLog(`Imported ${provider} account "${name}"`);
      }
      await this.saveConfig(this.config, { type: 'upsert', account: entry, previous });
    } catch (e) {
      this._addLog(`${provider} import failed: ${e.message}`);
    }
  }

  async _doImportCodex() {
    try {
      this._addLog('Importing Codex credentials...');
      const creds = await importCodexCredentials();
      let name = creds.email;
      if (!name) {
        let n = 1;
        do { name = `codex-account-${n++}`; } while (this.config.accounts.some(a => a.name === name));
      }
      const entry = {
        name,
        provider: 'codex',
        type: 'oauth',
        source: 'import',
        accountUuid: creds.accountId,
        accountId: creds.accountId,
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        idToken: creds.idToken,
        expiresAt: creds.expiresAt,
        email: creds.email,
        planType: creds.planType,
      };
      let idx = this.config.accounts.findIndex(a =>
        a.accountUuid === creds.accountId || a.accountId === creds.accountId);
      if (idx < 0) idx = this.config.accounts.findIndex(a => a.name === name);

      let previous = null;
      if (idx >= 0) {
        previous = this.config.accounts[idx];
        if (previous.enabled !== undefined) entry.enabled = previous.enabled;
        if (previous.priority !== undefined) entry.priority = previous.priority;
        this.config.accounts[idx] = entry;
        const live = this.am.accounts.find(a =>
          a.accountUuid === creds.accountId || a.name === previous.name);
        if (live) {
          this.am.updateAccountTokens(live, creds);
          live.name = name;
        } else {
          this.am.addAccount(entry);
        }
        this._addLog(`Updated Codex account "${name}"`);
      } else {
        this.config.accounts.push(entry);
        this.am.addAccount(entry);
        this._addLog(`Imported Codex account "${name}"`);
      }
      await this.saveConfig(this.config, { type: 'upsert', account: entry, previous });
    } catch (e) {
      this._addLog(`Codex import failed: ${e.message}`);
    }
  }

  async _doAddKey(apiKey) {
    // First FREE api-N — a `count + 1` scheme collides after a delete (e.g. add
    // api-1, api-2; delete api-1; the next add would reuse api-2). A unique name is
    // the identity key for credential-less API-key accounts, so it must not clash.
    let n = 1, name;
    do { name = `api-${n++}`; } while (this.config.accounts.some(a => a.name === name));
    const entry = { name, type: 'apikey', apiKey };
    this.config.accounts.push(entry);
    this.am.addAccount(entry);
    await this.saveConfig(this.config, { type: 'upsert', account: entry });
    this._addLog(`Added API key account "${name}"`);
  }

  async _doRemove(idx) {
    if (idx < 0 || idx >= this.am.accounts.length) return;
    const acct = this.am.accounts[idx];
    const name = acct.name;
    const uuid = acct.accountUuid;
    this.am.removeAccount(idx);
    // Splice the config entry by IDENTITY, not by the AccountManager index —
    // config.accounts can hold more entries than AccountManager (tokenless accounts
    // are skipped at load), so the AM index may delete a different config entry.
    // Two-phase (UUID first, then name): a single `uuid===c || name===c` predicate
    // could match an earlier same-name entry before the real UUID match.
    let cfgIdx = uuid ? this.config.accounts.findIndex(c => c.accountUuid === uuid) : -1;
    if (cfgIdx < 0) cfgIdx = this.config.accounts.findIndex(c => c.name === name);
    const removed = cfgIdx >= 0
      ? this.config.accounts[cfgIdx]
      : { name, accountUuid: uuid };
    if (cfgIdx >= 0) this.config.accounts.splice(cfgIdx, 1);
    // Drop a cursor anchor that pointed at the removed account; _selected()
    // falls back to the remembered position on the next keypress/render.
    if (this.selAcct && !this.am.accounts.includes(this.selAcct)) this.selAcct = null;
    if (this.selIdx >= this.am.accounts.length) this.selIdx = Math.max(0, this.am.accounts.length - 1);
    await this.saveConfig(this.config, { type: 'remove', account: removed });
    this._addLog(`Deleted account "${name}"`);
  }

  async _doToggleEnabled(idx) {
    const amAcct = this.am.accounts[idx];
    if (!amAcct) return;
    const newEnabled = amAcct.enabled === false; // currently disabled → enable, else disable
    // Mutate the live AccountManager (excludes/includes it in rotation, drains
    // waiters on enable). Persist the flag onto the matching config entry found
    // by identity — config.accounts can hold more entries than AccountManager
    // (tokenless accounts are skipped at load), so the display index may not map
    // 1:1 onto config.accounts. Matching by UUID/name avoids corrupting a
    // different config entry.
    this.am.setEnabled(amAcct, newEnabled);
    // Match the config entry UUID-first, then name — an OR match could persist the
    // flag onto the wrong entry when a UUID and a name resolve to different accounts.
    const cfg = (amAcct.accountUuid && this.config.accounts.find(a => a.accountUuid === amAcct.accountUuid))
      || this.config.accounts.find(a => a.name === amAcct.name);
    if (cfg) cfg.enabled = newEnabled;
    await this.saveConfig(this.config, {
      type: 'patch',
      account: amAcct,
      fields: { enabled: newEnabled ? undefined : false },
    });
    this._addLog(`${newEnabled ? 'Enabled' : 'Disabled'} "${amAcct.name}"`);
  }

  // ── ordering (priority expressed as a movable rank, not a typed number) ──────
  //
  // The user sets preference by moving accounts up/down, not by entering a number.
  // Ranked accounts get contiguous priorities 0,1,2,… (0 = most preferred and
  // shown as "#1"); accounts left unranked keep priority null and are routed by
  // use-or-lose (soonest reset, then least used). So pinning a few accounts to an
  // explicit order leaves the rest on the auto rotation.

  /** Ranked accounts (priority set), in order: priority asc, then array index. */
  _rankedSorted() {
    return this.am.accounts
      .filter(a => a.priority != null)
      .sort((a, b) => (a.priority - b.priority) || (a.index - b.index));
  }

  /**
   * Display order: ranked accounts first (in rank order), then unranked in
   * their ACTUAL automatic drain order (weekly reset soonest first — the same
   * comparator selection uses), so the list shows what "auto" will do next.
   * autoCompare returns 0 on ties and Array.sort is stable, so accounts with
   * no quota data keep their array order (the previous display behavior).
   */
  _displayList() {
    const ranked = this._rankedSorted();
    const set = new Set(ranked);
    const auto = this.am.accounts.filter(a => !set.has(a)).sort((a, b) => this.am.autoCompare(a, b));
    return [...ranked, ...auto];
  }

  /** 1-based rank position among the ranked accounts, or null if unranked. */
  _rankOf(account) {
    if (account.priority == null) return null;
    return this._rankedSorted().indexOf(account) + 1;
  }

  /**
   * Move an account up (dir < 0, more preferred) or down (dir > 0) in the order.
   * Moving an unranked account up ranks it at the bottom of the ranked group;
   * moving the last ranked account down un-ranks it (back to use-or-lose). After
   * the move, ranked accounts are renumbered to contiguous priorities 0..n-1 (also
   * normalizing any duplicate/legacy values), and every changed account is
   * persisted onto its config entry (matched UUID-first, then name).
   */
  _moveOrder(account, dir) {
    if (!this.am.accounts.includes(account)) return;
    const ranked = this._rankedSorted();
    const r = ranked.indexOf(account);

    if (dir < 0) {                       // up — more preferred
      if (r === -1) ranked.push(account);                                          // unranked → lowest ranked
      else if (r > 0) { const t = ranked[r - 1]; ranked[r - 1] = ranked[r]; ranked[r] = t; }
      else return;                                                                 // already at the top
    } else {                             // down — less preferred
      if (r === -1) return;                                                        // unranked: nothing below
      else if (r < ranked.length - 1) { const t = ranked[r + 1]; ranked[r + 1] = ranked[r]; ranked[r] = t; }
      else ranked.splice(r, 1);                                                    // last ranked → un-rank
    }

    this._applyRanking(ranked);
  }

  /**
   * Un-rank an account back to "auto" (automatic use-or-lose routing: weekly
   * reset soonest first). A no-op when it's already unranked — but the
   * renumber below still normalizes any legacy/duplicate priorities.
   */
  _setAutoOrder(account) {
    if (!this.am.accounts.includes(account)) return;
    this._applyRanking(this._rankedSorted().filter(a => a !== account));
  }

  /**
   * Persist a new ranked order: reassign contiguous priorities (ranked → its
   * index; everyone else → null), mutating the live AccountManager and the
   * config in lockstep, then schedule a coalesced save.
   */
  _applyRanking(ranked) {
    const set = new Set(ranked);
    for (const a of this.am.accounts) {
      const want = set.has(a) ? ranked.indexOf(a) : null;
      if (a.priority === want) continue;
      this.am.setPriority(a, want);
      // Persist onto the config entry by identity (UUID-first, then name) — the
      // display index may not map 1:1 onto config.accounts. Write `null` (not a
      // deleted key) to clear, so the saveConfig `{...diskAcct, ...live}` merge
      // can't let a stale disk priority survive.
      const cfg = (a.accountUuid && this.config.accounts.find(c => c.accountUuid === a.accountUuid))
        || this.config.accounts.find(c => c.name === a.name);
      if (cfg) cfg.priority = want;
    }
    // Persist via the coalescing saver: rapid ↑/↓ presses mutate synchronously but
    // share a single in-flight write whose final pass reflects the latest order, so
    // an out-of-order completion can't persist a stale snapshot.
    this._scheduleSave();
  }

  /**
   * Serialize config writes triggered by rapid order moves. Only one save runs at
   * a time; further changes during it set `_saveDirty`, and the loop runs one more
   * pass with the latest `this.config` when the current write finishes — so the
   * last write always reflects the newest state (no lost-update race).
   */
  _scheduleSave() {
    this._saveDirty = true;
    if (this._saving) return;
    this._saving = (async () => {
      while (this._saveDirty) {
        this._saveDirty = false;
        const patches = this.am.accounts.map(account => ({
          account,
          fields: { priority: account.priority },
        }));
        try { await this.saveConfig(this.config, { type: 'batchPatch', patches }); }
        catch (e) { this._addLog(`Save failed: ${e.message}`); }
      }
      this._saving = null;
    })();
  }

  // ── rendering ──────────────────────────────────────

  _provider() {
    return this.config.provider || 'anthropic';
  }

  _brandLabel() {
    return {
      anthropic: 'TeamClaude',
      codex: 'TeamCodex',
      grok: 'TeamGrok',
      agy: 'TeamAgy',
    }[this._provider()] || 'TeamClaude';
  }

  _proxyPort() {
    return this.config.proxy?.port || providerDefaultPort(this._provider());
  }

  render() {
    if (!this.running) return;
    const W = process.stdout.columns || 80;
    const H = process.stdout.rows || 24;

    if (W < 40 || H < 8) {
      process.stdout.write(`${ESC}H${ESC}2JTerminal too small (need 40x8+)\r\n`);
      return;
    }

    const lines = [];

    // ── Header
    const left = bold(` ${this._brandLabel()}`);
    const port = this._proxyPort();
    // Host CPU/RAM at a glance (render loop ticks often enough for live CPU%).
    // Thresholds mirror the quota bars: calm → green-ish default, 70%+ warns,
    // 90%+ screams — this box dying from overload is a real failure mode.
    const h = this._host.sample();
    const paint = (pct, s) => (pct == null ? dim(s) : pct >= 90 ? red(s) : pct >= 70 ? yellow(s) : s);
    const cpuS = paint(h.cpu.usedPct, `CPU ${h.cpu.usedPct != null ? h.cpu.usedPct.toFixed(0) + '%' : '–'}`);
    const memS = paint(h.memory.usedPct, `RAM ${h.memory.usedPct != null ? h.memory.usedPct.toFixed(0) + '%' : '–'}`);
    // The host segment is optional: on a narrow terminal (W can be as low as 40)
    // the full header would exceed W — Math.max floors the gap at 1 but the line
    // itself would wrap and corrupt the fixed frame. Drop CPU/RAM before Port.
    let right = `${cpuS} ${dim('·')} ${memS} ${dim('·')} Port ${port} ${green('▲')} `;
    if (vw(left) + vw(right) + 1 > W) right = `Port ${port} ${green('▲')} `;
    lines.push(left + ' '.repeat(Math.max(1, W - vw(left) - vw(right))) + right);
    lines.push(' ' + dim('─'.repeat(W - 2)));

    // ── Accounts
    if (this.am.accounts.length === 0) {
      lines.push('');
      lines.push(yellow('  No accounts configured. Press [a] to add one.'));
    } else {
      lines.push('');
      // Three quota bars (Ses / Wk / Fbl) when the terminal is wide enough,
      // two (Ses / Wk) on mid widths, one on narrow ones.
      const showThree = W >= 92;
      const showBoth = W >= 70;
      // The +4 in each offset reserves the width of the leading row-number
      // column (" NN." + its separator), so adding it doesn't push the bars
      // past the terminal edge and clip the rightmost (Fbl) bar.
      const bw = showThree
        ? Math.max(5, Math.min(20, Math.floor((W - 66) / 3)))
        : showBoth
          ? Math.max(5, Math.min(20, Math.floor((W - 60) / 2)))
          : Math.max(5, Math.min(20, W - 49));

      // Sync the cursor position to the anchored account before drawing — the
      // display order may have changed since the last frame (quota updates
      // re-sort the auto group), and the highlight must follow the account.
      this._selected();
      const display = this._displayList();
      for (let pos = 0; pos < display.length; pos++) {
        lines.push(this._renderAcct(display[pos], pos, bw, showBoth, showThree));
      }
    }

    // ── Activity header
    lines.push('');
    const ac = this.active.size;
    const acTag = ac > 0 ? `  ${cyan(ac + ' active')}` : '';
    const aHdr = ` Activity${acTag} `;
    lines.push(aHdr + dim('─'.repeat(Math.max(1, W - vw(aHdr)))));

    // Active requests
    const now = Date.now();
    for (const [, r] of this.active) {
      const el = ((now - r.started) / 1000).toFixed(1);
      const sp = cyan(SPINNER[this.frame]);
      const a = r.account ? ` → ${r.account}` : '';
      lines.push(` ${sp} ${gray(r.t)}  ${r.method} ${r.path}${a} ${dim(`(${el}s...)`)}`);
    }

    // Completed log
    const footerH = 2;
    const space = Math.max(0, H - lines.length - footerH);
    for (let i = 0; i < space && i < this.log.length; i++) {
      lines.push(`   ${gray(this.log[i].t)}  ${this.log[i].msg}`);
    }

    // Pad to fill
    while (lines.length < H - footerH) lines.push('');

    // ── Footer
    lines.push(' ' + dim('─'.repeat(W - 2)));
    lines.push(this._renderFooter());

    // Write buffer
    let buf = `${ESC}H`;
    for (let i = 0; i < H; i++) {
      buf += fitLine(lines[i] || '', W);
      if (i < H - 1) buf += '\r\n';
    }
    // Show cursor only in input mode
    buf += this.mode === 'input' ? `${ESC}?25h` : `${ESC}?25l`;
    process.stdout.write(buf);
  }

  _renderAcct(a, pos, bw, showBoth, showThree = false) {
    const isCur = a === this.am.accounts[this.am.currentIndex];
    // Highlight the selection in both select and order modes; in order mode the
    // grabbed account gets a distinct move marker.
    const isSel = (this.mode === 'normal' || this.mode === 'select' || this.mode === 'order') && pos === this.selIdx;
    const isMoving = this.mode === 'order' && a === this.orderAccount;

    // Prefix: selection / move marker + current marker
    const sel = isMoving ? cyan('⇅') : isSel ? cyan('>') : ' ';
    const cur = isCur ? green('►') : ' ';

    // Row number — the account's 1-based position in the displayed order, so
    // the list is easy to reference at a glance. Right-aligned to 2 cols (fleet
    // sizes are small; a 3rd digit just widens the gutter for 100+ accounts).
    const num = gray(String(pos + 1).padStart(2) + '.');

    // Name (bold if selected)
    const rawName = a.name.slice(0, 12).padEnd(12);
    const name = isSel ? bold(rawName) : rawName;

    // Type
    const type = gray(a.type.padEnd(7));

    // Status — a manually-disabled account reads "disabled" regardless of its
    // underlying quota status, since it's out of rotation either way.
    let status;
    if (a.enabled === false) {
      status = gray('disabled');
    } else {
      switch (a.status) {
        case 'active':    status = isCur ? green('active') : 'active'; break;
        case 'throttled': status = yellow('throttled'); break;
        case 'exhausted': status = red('exhausted'); break;
        // The structured 403 means organization access is denied; it does not
        // prove payment delinquency. Keep it distinct from generic auth error.
        // ASCII on purpose: double-width Hangul would break rpad().
        case 'error':     status = red(a.errorReason === 'subscription-disabled'
          ? 'access'
          : this._canReauthenticate(a) ? 'reauth' : 'error'); break;
        default:          status = a.status || 'ready';
      }
    }
    status = rpad(status, 10);

    // Quota ratios — labelled by account TYPE, not by which data happens to be
    // present. An OAuth (Claude Max) account always shows Ses/Wk (with "-" when
    // not yet measured); an API-key account shows Tok/Req. Keying on the data
    // (unified5h != null) mislabels an unmeasured OAuth account as Tok/Req.
    const q = a.quota;
    let r1 = null, r2 = null, l1 = 'Ses', l2 = 'Wk ', t1 = null, t2 = null;
    let r3 = null, l3 = null, t3 = null;

    if (a.type === 'oauth') {
      r1 = q.unified5h;
      r2 = q.unified7d;
      t1 = q.unified5hReset;
      t2 = q.unified7dReset;
      // Third bar: the model-scoped weekly window (7d_oi — the top-model weekly
      // limit shown as "Fable" in Claude's usage UI). Prefer 7d_oi explicitly so
      // another window appearing first can't hide the Fable quota; an unknown
      // label still renders, tagged by its suffix, so a renamed header keeps
      // showing.
      const mw = q.modelWeekly && (
        ('7d_oi' in q.modelWeekly && ['7d_oi', q.modelWeekly['7d_oi']])
        || Object.entries(q.modelWeekly)[0]);
      l3 = 'Fbl';
      if (mw) {
        const [label, win] = mw;
        if (label !== '7d_oi') l3 = (label.slice(3) + '   ').slice(0, 3);
        r3 = win.utilization;
        t3 = win.reset;
      }
    } else {
      l1 = 'Tok';
      l2 = 'Req';
      r1 = (q.tokensLimit != null && q.tokensRemaining != null)
        ? 1 - q.tokensRemaining / q.tokensLimit : null;
      r2 = (q.requestsLimit != null && q.requestsRemaining != null)
        ? 1 - q.requestsRemaining / q.requestsLimit : null;
      t1 = q.resetsAt ? new Date(q.resetsAt).getTime() : null;
      t2 = t1;
    }

    let line = ` ${sel}${cur} ${num} ${name} ${type} ${status} ${l1} ${bar(r1, bw, t1)}`;
    if (showBoth) {
      line += `  ${l2} ${bar(r2, bw, t2)}`;
    }
    if (showThree) {
      // API-key accounts have no third metric — pad the slot so the rank
      // badges stay column-aligned across mixed account types.
      line += l3 ? `  ${l3} ${bar(r3, bw, t3)}` : ' '.repeat(6 + bw);
    }
    // Order badge: ranked accounts show their 1-based position (#1 = most
    // preferred). While ordering, unranked accounts are labelled "auto" so the
    // two groups (pinned order vs use-or-lose) are visible. Appended last so it
    // never disrupts the fixed-width columns / quota bars.
    const rank = this._rankOf(a);
    if (rank != null) line += `  ${dim('#' + rank)}`;
    else if (this.mode === 'order') line += `  ${dim('auto')}`;
    return line;
  }

  _renderFooter() {
    switch (this.mode) {
      case 'normal': {
        const selected = this._selected();
        if (!selected) {
          return ` [${bold('a')}] Add account  [${bold('R')}] Reload  [${bold('q')}] Quit`;
        }
        const reauth = this._canReauthenticate(selected)
          ? `  ${red('재인증 필요')} [${bold('r')}]`
          : '';
        return ` [${bold('d')}] Delete account  Selected: ${bold(selected.name)}${reauth}  ${dim('↑↓')} Select  [${bold('s')}] Switch  [${bold('e')}] Enable/disable  [${bold('o')}] Order  [${bold('a')}] Add  [${bold('R')}] Reload  [${bold('q')}] Quit`;
      }
      case 'select': {
        const selected = this._selected();
        return ` ${red(`Delete account "${selected?.name || '?'}"?`)}  [${bold('Enter')}] Confirm delete  [${bold('Esc')}] Cancel  ${dim('↑↓ Change target')}`;
      }
      case 'order':
        return ` ${dim('↑↓')} move (up = preferred)  ${bold('a')}uto-all (reset order, weekly-reset)  ${bold('c')}lear rank  ${bold('Enter')}/${bold('Esc')} done`;
      case 'add':
        if (this.config.provider === 'codex') {
          return ` ${bold('i')}mport Codex login  ${bold('Esc')} cancel`;
        }
        if (this.config.provider === 'grok' || this.config.provider === 'agy') {
          return ` ${bold('i')}mport ${this.config.provider} OAuth  (or run teamcodex ${this.config.provider} login)  ${bold('Esc')} cancel`;
        }
        return ` ${bold('i')}mport Claude Code  ${bold('k')} API key  ${bold('Esc')} cancel`;
      case 'input':
        return ` ${this.inputPrompt}: ${this.inputBuf}█`;
      default:
        return '';
    }
  }
}
