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
