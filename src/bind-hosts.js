import { isIP } from 'node:net';

// Which local addresses the supervisor's public listener binds.
//
// Default: loopback only (127.0.0.1 and ::1), never the wildcard address.
// proxy.bindHosts may add hosts. Loopback and Tailscale-range addresses
// (IPv4 100.64.0.0/10, IPv6 fd7a:115c:a1e0::/48) are allowed as-is; any other
// address, including private LAN ranges and the wildcard 0.0.0.0 / ::, needs
// proxy.allowLanBind === true. A violation throws so startup is refused.

export const DEFAULT_BIND_HOSTS = Object.freeze(['127.0.0.1', '::1']);

const LOOPBACK_BIND_HOSTS = new Set(['127.0.0.1', '::1']);
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::']);

export function isLoopbackBindHost(host) {
  return LOOPBACK_BIND_HOSTS.has(host);
}

export function isWildcardBindHost(host) {
  return WILDCARD_BIND_HOSTS.has(host);
}

function expandIPv6(host) {
  const [head, tail] = host.includes('::') ? host.split('::') : [host, null];
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const missing = tail == null ? 0 : 8 - headParts.length - tailParts.length;
  return [...headParts, ...Array(missing).fill('0'), ...tailParts]
    .map(part => Number.parseInt(part || '0', 16));
}

export function isTailscaleAddress(host) {
  const family = isIP(host);
  if (family === 4) {
    const [first, second] = host.split('.').map(Number);
    return first === 100 && second >= 64 && second <= 127;
  }
  if (family === 6) {
    // IPv4-embedded forms (a dotted tail) are not part of the Tailscale range.
    if (host.includes('.')) return false;
    const groups = expandIPv6(host);
    return groups[0] === 0xfd7a && groups[1] === 0x115c && groups[2] === 0xa1e0;
  }
  return false;
}

export function resolveBindHosts(config) {
  const proxy = config?.proxy || {};
  if (proxy.bindHosts === undefined) return [...DEFAULT_BIND_HOSTS];
  const hosts = proxy.bindHosts;
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error('proxy.bindHosts must be a non-empty array of IP addresses.');
  }
  const allowLan = proxy.allowLanBind === true;
  const seen = new Set();
  hosts.forEach((host, index) => {
    if (typeof host !== 'string' || isIP(host) === 0) {
      throw new Error(`proxy.bindHosts[${index}] must be an IP address literal, got ${JSON.stringify(host)}.`);
    }
    if (seen.has(host)) {
      throw new Error(`proxy.bindHosts lists ${host} more than once.`);
    }
    seen.add(host);
    if (isLoopbackBindHost(host)) return;
    if (index === 0 && !(allowLan && isWildcardBindHost(host))) {
      // A wildcard first host already covers loopback, so it is accepted with
      // the LAN opt-in; any other first host must be loopback.
      throw new Error('proxy.bindHosts must start with a loopback address (127.0.0.1 or ::1).');
    }
    if (isTailscaleAddress(host)) return;
    if (!allowLan) {
      throw new Error(
        `proxy.bindHosts entry ${host} is outside loopback and the Tailscale range; `
        + 'set proxy.allowLanBind to true to bind it.',
      );
    }
  });
  // Discovery and management clients probe 127.0.0.1, so an IPv4 loopback
  // (or a wildcard that covers it) must always be bound.
  if (!hosts.some(host => host === '127.0.0.1' || isWildcardBindHost(host))) {
    throw new Error('proxy.bindHosts must include 127.0.0.1 (local clients probe the IPv4 loopback).');
  }
  return [...hosts];
}

// Addresses to actually listen on, each with whether its bind failure must
// fail startup. A wildcard already accepts connections to the loopback of its
// own address family, so that loopback is dropped instead of being bound (and
// pre-checked) separately: the pre-check would otherwise connect to our own
// wildcard listener and report the port as in use. Only same-family pairs are
// merged (0.0.0.0 covers 127.0.0.1, :: covers ::1).
//
// Requirements come from the original list, not from the filtered order:
// loopback hosts and the first host are required, a wildcard that replaces a
// loopback inherits that loopback's requirement, and the host that provides
// the IPv4 loopback local clients probe is always required. Other hosts stay
// optional. skipWithoutIpv6 marks a requirement that only comes from ::1,
// which is skipped on a host without IPv6.
export function listenBindTargets(hosts) {
  const hasIpv4Wildcard = hosts.includes('0.0.0.0');
  const hasIpv6Wildcard = hosts.includes('::');
  const ipv4ProvidedByIpv6Wildcard = !hasIpv4Wildcard && !hosts.includes('127.0.0.1');
  const target = (host, required, skipWithoutIpv6 = false) => ({ host, required, skipWithoutIpv6 });
  return hosts.flatMap((host, index) => {
    if (host === '127.0.0.1') return hasIpv4Wildcard ? [] : [target(host, true)];
    if (host === '::1') return hasIpv6Wildcard ? [] : [target(host, true, true)];
    if (host === '0.0.0.0') return [target(host, true)];
    if (host === '::') {
      if (index === 0 || ipv4ProvidedByIpv6Wildcard) return [target(host, true)];
      return [target(host, hosts.includes('::1'), hosts.includes('::1'))];
    }
    return [target(host, index === 0)];
  });
}

// Loopback hosts that listenBindTargets folds into a same-family wildcard.
// They are not bound on their own, but another process may still hold them.
export function foldedLoopbackHosts(hosts) {
  return hosts.filter(host => (host === '127.0.0.1' && hosts.includes('0.0.0.0'))
    || (host === '::1' && hosts.includes('::')));
}

const IPV4_LOOPBACK_COVERING_HOSTS = new Set(['127.0.0.1', '0.0.0.0']);

// Whether a failed bind must fail startup ('fail') or is skipped with a
// warning ('skip'). ipv4LoopbackServed says a listener we already opened
// answers on 127.0.0.1 (a dual-stack :: does): an EADDRINUSE on the IPv4
// loopback or IPv4 wildcard then only overlaps our own listener.
export function bindFailureAction({ target, code, ipv4LoopbackServed = false }) {
  if (code === 'EADDRINUSE' && ipv4LoopbackServed && IPV4_LOOPBACK_COVERING_HOSTS.has(target.host)) {
    return 'skip';
  }
  // ::1 is skipped only when the host has no usable IPv6 loopback at all;
  // a busy ::1 (EADDRINUSE) still fails startup like 127.0.0.1 does.
  const ipv6Unavailable = code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT';
  if (target.required) return target.skipWithoutIpv6 && ipv6Unavailable ? 'skip' : 'fail';
  return code === 'EADDRNOTAVAIL' || code === 'EADDRINUSE' ? 'skip' : 'fail';
}

function addressInUseError(host, port) {
  return Object.assign(new Error(`listen EADDRINUSE: address already in use ${host}:${port}`), {
    code: 'EADDRINUSE',
  });
}

// Bind every configured host with injected I/O:
//   portInUse(host)       -> whether something already answers on host:port
//   listen(host)          -> null on success, or the bind error
//   servesIpv4Loopback()  -> whether 127.0.0.1:port reaches a listener we opened
//   warn(message)         -> skip warning sink
// Folded loopback hosts are pre-checked before any listener opens, so the
// check cannot mistake our own wildcard for another process. A loopback
// target is pre-checked right before its bind, as before. Resolves to
// { ok: true } or { ok: false, err, noListener }.
export async function bindPublicHosts(hosts, { port, portInUse, listen, servesIpv4Loopback, warn }) {
  for (const host of foldedLoopbackHosts(hosts)) {
    if (await portInUse(host)) return { ok: false, err: addressInUseError(host, port), noListener: false };
  }
  let bound = 0;
  for (const target of listenBindTargets(hosts)) {
    const { host } = target;
    const err = isLoopbackBindHost(host) && await portInUse(host)
      ? addressInUseError(host, port)
      : await listen(host);
    if (!err) {
      bound += 1;
      continue;
    }
    const ipv4LoopbackServed = err.code === 'EADDRINUSE' && bound > 0
      && IPV4_LOOPBACK_COVERING_HOSTS.has(host) && await servesIpv4Loopback();
    if (bindFailureAction({ target, code: err.code, ipv4LoopbackServed }) === 'fail') {
      return { ok: false, err, noListener: false };
    }
    warn(`[TeamClaude] Skipping bind ${host}: ${err.code}`);
  }
  if (bound === 0) return { ok: false, err: new Error('no bind host could be bound'), noListener: true };
  return { ok: true };
}
