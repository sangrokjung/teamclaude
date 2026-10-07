/**
 * Carry the routing settings of a config entry that a (re-)login or import
 * replaces onto the fresh entry. Mutates `account`.
 *
 * A browser login is the owner explicitly asking to use that account, so it
 * lifts a manual `disable` — an account parked while its organization blocked
 * Claude Code otherwise stayed out of rotation after the owner logged it back
 * in, with nothing saying why. A file import keeps the flag: it can run
 * without anyone deciding anything about that account. The subscription mark
 * is not carried either way; a still-blocked account is parked again by the
 * next 403, so re-enabling cannot put a broken account into rotation.
 *
 * @returns {{ reenabled: boolean, stillDisabled: boolean }}
 */
export function carryOverAccountSettings(previous, account, source) {
  let reenabled = false;
  if (previous.enabled === false && source === 'login') {
    reenabled = true;
  } else if (previous.enabled !== undefined) {
    account.enabled = previous.enabled;
  }
  if (previous.priority !== undefined) account.priority = previous.priority;
  if (previous.maxConcurrent !== undefined) account.maxConcurrent = previous.maxConcurrent;
  if (previous.subscriptionCancellation !== undefined) {
    account.subscriptionCancellation = previous.subscriptionCancellation;
  }
  return { reenabled, stillDisabled: account.enabled === false };
}

/**
 * Insert or replace an OAuth account in `cfg` (mutated): the config half of
 * `login`/`import`, kept free of I/O so it can be checked against a fixture.
 * Matches the profile's account UUID first, then the name; an unnamed account
 * without a profile email gets the first free `account-N` (not `count + 1`,
 * which collides after a delete).
 *
 * @returns {{ action: 'Added'|'Updated', name: string, carried: object|null }}
 */
export function applyOAuthUpsert(cfg, { name, creds, profile, source }) {
  if (!name) {
    let n = 1;
    do { name = `account-${n++}`; } while (cfg.accounts.some(a => a.name === name));
  }
  const account = {
    name,
    type: 'oauth',
    source,
    accountUuid: profile?.accountUuid || null,
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  };
  // Plan tier drives the usage-limit grace cadence (Pro: once a week).
  const planType = profile?.hasClaudeMax ? 'max'
    : profile?.hasClaudePro ? 'pro'
      : typeof creds.planType === 'string' && creds.planType ? creds.planType.toLowerCase() : null;
  if (planType) account.planType = planType;
  let idx = profile?.accountUuid
    ? cfg.accounts.findIndex(a => a.accountUuid === profile.accountUuid)
    : -1;
  if (idx < 0) idx = cfg.accounts.findIndex(a => a.name === name);
  if (idx < 0) {
    cfg.accounts.push(account);
    return { action: 'Added', name, carried: null };
  }
  const carried = carryOverAccountSettings(cfg.accounts[idx], account, source);
  cfg.accounts[idx] = account;
  return { action: 'Updated', name, carried };
}
