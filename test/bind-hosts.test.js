import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindPublicHosts, isOwnIpv4LoopbackProbe, listenBindTargets, resolveBindHosts } from '../src/bind-hosts.js';

const listenBindHosts = hosts => listenBindTargets(hosts).map(target => target.host);

test('default is loopback only', () => {
  assert.deepEqual(resolveBindHosts({}), ['127.0.0.1', '::1']);
  assert.deepEqual(resolveBindHosts({ proxy: { port: 3456 } }), ['127.0.0.1', '::1']);
});

test('rejects wildcard host without opt-in', () => {
  assert.throws(() => resolveBindHosts({ proxy: { bindHosts: ['0.0.0.0'] } }), Error);
});

test('allows wildcard host with allowLanBind', () => {
  assert.deepEqual(
    resolveBindHosts({ proxy: { bindHosts: ['0.0.0.0'], allowLanBind: true } }),
    ['0.0.0.0'],
  );
  assert.deepEqual(
    resolveBindHosts({ proxy: { bindHosts: ['127.0.0.1', '192.168.1.10'], allowLanBind: true } }),
    ['127.0.0.1', '192.168.1.10'],
  );
});

test('rejects non-loopback first host', () => {
  assert.throws(() => resolveBindHosts({ proxy: { bindHosts: ['192.0.2.10', '127.0.0.1'] } }), Error);
});

test('rejects hostnames', () => {
  assert.throws(() => resolveBindHosts({ proxy: { bindHosts: ['localhost'] } }), Error);
});

test('rejects private LAN host without opt-in', () => {
  assert.throws(() => resolveBindHosts({ proxy: { bindHosts: ['127.0.0.1', '192.168.1.10'] } }), Error);
});

test('accepts a Tailscale-range host', () => {
  assert.deepEqual(
    resolveBindHosts({ proxy: { bindHosts: ['127.0.0.1', '100.100.100.100'] } }),
    ['127.0.0.1', '100.100.100.100'],
  );
});

test('accepts a Tailscale-range IPv6 host and rejects a lookalike', () => {
  assert.deepEqual(
    resolveBindHosts({ proxy: { bindHosts: ['::1', '127.0.0.1', 'fd7a:115c:a1e0::1'] } }),
    ['::1', '127.0.0.1', 'fd7a:115c:a1e0::1'],
  );
  assert.throws(() => resolveBindHosts({ proxy: { bindHosts: ['::1', '127.0.0.1', 'fd7a:115c:a1e1::1'] } }), Error);
});

test('rejects bindHosts without the IPv4 loopback that local probes use', () => {
  assert.throws(() => resolveBindHosts({ proxy: { bindHosts: ['::1'] } }), /127\.0\.0\.1/);
  assert.throws(() => resolveBindHosts({ proxy: { bindHosts: ['::1', 'fd7a:115c:a1e0::1'] } }), /127\.0\.0\.1/);
});

test('rejects non-array and empty bindHosts', () => {
  assert.throws(() => resolveBindHosts({ proxy: { bindHosts: '127.0.0.1' } }), Error);
  assert.throws(() => resolveBindHosts({ proxy: { bindHosts: [] } }), Error);
  assert.throws(() => resolveBindHosts({ proxy: { bindHosts: ['127.0.0.1', 42] } }), Error);
});

test('a same-family wildcard covers the loopback bind', () => {
  const hosts = resolveBindHosts({ proxy: { bindHosts: ['0.0.0.0', '127.0.0.1'], allowLanBind: true } });
  assert.deepEqual(listenBindHosts(hosts), ['0.0.0.0']);
  assert.deepEqual(listenBindHosts(['127.0.0.1', '0.0.0.0']), ['0.0.0.0']);
  assert.deepEqual(listenBindHosts(['0.0.0.0', '::', '127.0.0.1', '::1']), ['0.0.0.0', '::']);
});

test('loopback of another family is kept beside a wildcard', () => {
  assert.deepEqual(listenBindHosts(['0.0.0.0', '::1']), ['0.0.0.0', '::1']);
  assert.deepEqual(listenBindHosts(['::', '127.0.0.1']), ['::', '127.0.0.1']);
});

test('bind targets without a wildcard are unchanged', () => {
  assert.deepEqual(listenBindHosts(['127.0.0.1', '::1']), ['127.0.0.1', '::1']);
  assert.deepEqual(listenBindHosts(['127.0.0.1', '100.100.100.100']), ['127.0.0.1', '100.100.100.100']);
});

test('an extra host stays optional when an earlier loopback is covered', () => {
  assert.deepEqual(listenBindTargets(['127.0.0.1', '100.100.100.100', '0.0.0.0']), [
    { host: '100.100.100.100', required: false, skipWithoutIpv6: false },
    { host: '0.0.0.0', required: true, skipWithoutIpv6: false },
  ]);
});

test('a wildcard that replaces a loopback inherits its requirement', () => {
  assert.deepEqual(listenBindTargets(['127.0.0.1', '::1', '0.0.0.0']), [
    { host: '::1', required: true, skipWithoutIpv6: true },
    { host: '0.0.0.0', required: true, skipWithoutIpv6: false },
  ]);
  assert.deepEqual(listenBindTargets(['127.0.0.1', '::1', '::']), [
    { host: '127.0.0.1', required: true, skipWithoutIpv6: false },
    { host: '::', required: true, skipWithoutIpv6: true },
  ]);
});

test('default and plain extra hosts keep their requirements', () => {
  assert.deepEqual(listenBindTargets(['127.0.0.1', '::1']), [
    { host: '127.0.0.1', required: true, skipWithoutIpv6: false },
    { host: '::1', required: true, skipWithoutIpv6: true },
  ]);
  assert.deepEqual(listenBindTargets(['127.0.0.1', '192.0.2.10', '::']), [
    { host: '127.0.0.1', required: true, skipWithoutIpv6: false },
    { host: '192.0.2.10', required: false, skipWithoutIpv6: false },
    { host: '::', required: false, skipWithoutIpv6: false },
  ]);
});

test('the host that covers the IPv4 loopback is always required', () => {
  assert.deepEqual(listenBindTargets(['::1', '0.0.0.0']), [
    { host: '::1', required: true, skipWithoutIpv6: true },
    { host: '0.0.0.0', required: true, skipWithoutIpv6: false },
  ]);
  assert.deepEqual(listenBindTargets(['::1', '192.0.2.10', '::']), [
    { host: '192.0.2.10', required: false, skipWithoutIpv6: false },
    { host: '::', required: true, skipWithoutIpv6: false },
  ]);
  assert.deepEqual(listenBindTargets(['::', '192.0.2.10']), [
    { host: '::', required: true, skipWithoutIpv6: false },
    { host: '192.0.2.10', required: false, skipWithoutIpv6: false },
  ]);
});

// Runs bindPublicHosts against injected bind results and records the order of
// pre-checks and binds. busy: hosts whose pre-check finds another listener.
// fail: host -> bind error code. ipv4Served: what the IPv4 loopback probe sees.
async function simulateBind(hosts, { busy = [], fail = {}, ipv4Served = false } = {}) {
  const calls = [];
  const warnings = [];
  const result = await bindPublicHosts(hosts, {
    port: 3456,
    portInUse: async host => {
      calls.push(`check ${host}`);
      return busy.includes(host);
    },
    listen: async host => {
      calls.push(`bind ${host}`);
      const code = fail[host];
      return code ? Object.assign(new Error(`listen ${code}`), { code }) : null;
    },
    servesIpv4Loopback: async () => {
      calls.push('probe ipv4');
      return ipv4Served;
    },
    warn: message => warnings.push(message),
  });
  return { ...result, calls, warnings };
}

test('dual-stack wildcard overlap is tolerated when IPv4 loopback is already served', async () => {
  const result = await simulateBind(['::', '0.0.0.0'], { fail: { '0.0.0.0': 'EADDRINUSE' }, ipv4Served: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.calls, ['bind ::', 'bind 0.0.0.0', 'probe ipv4']);
  assert.match(result.warnings.join('\n'), /Skipping bind 0\.0\.0\.0: EADDRINUSE/);
});

test('dual-stack wildcard overlap fails startup when IPv4 loopback is not served', async () => {
  const result = await simulateBind(['::', '0.0.0.0'], { fail: { '0.0.0.0': 'EADDRINUSE' }, ipv4Served: false });
  assert.equal(result.ok, false);
  assert.equal(result.err.code, 'EADDRINUSE');
});

test('IPv4 wildcard EADDRINUSE without an earlier listener still fails startup', async () => {
  const result = await simulateBind(['0.0.0.0', '::'], { fail: { '0.0.0.0': 'EADDRINUSE' }, ipv4Served: true });
  assert.equal(result.ok, false);
  assert.equal(result.err.code, 'EADDRINUSE');
  assert.ok(!result.calls.includes('probe ipv4'));
});

test('a folded loopback is pre-checked before any listener opens', async () => {
  const ok = await simulateBind(['127.0.0.1', '0.0.0.0']);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.calls, ['check 127.0.0.1', 'bind 0.0.0.0']);
  const busy = await simulateBind(['127.0.0.1', '0.0.0.0'], { busy: ['127.0.0.1'] });
  assert.equal(busy.ok, false);
  assert.equal(busy.err.code, 'EADDRINUSE');
  assert.match(busy.err.message, /127\.0\.0\.1:3456/);
  assert.deepEqual(busy.calls, ['check 127.0.0.1']);
  const both = await simulateBind(['0.0.0.0', '::', '127.0.0.1', '::1'], { busy: ['::1'] });
  assert.equal(both.ok, false);
  assert.deepEqual(both.calls, ['check 127.0.0.1', 'check ::1']);
});

test('default bind keeps its pre-check order and failure rules', async () => {
  const ok = await simulateBind(['127.0.0.1', '::1']);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.calls, ['check 127.0.0.1', 'bind 127.0.0.1', 'check ::1', 'bind ::1']);
  const noIpv6 = await simulateBind(['127.0.0.1', '::1'], { fail: { '::1': 'EADDRNOTAVAIL' } });
  assert.equal(noIpv6.ok, true);
  const busyIpv6 = await simulateBind(['127.0.0.1', '::1'], { busy: ['::1'] });
  assert.equal(busyIpv6.ok, false);
  assert.equal(busyIpv6.err.code, 'EADDRINUSE');
  const busyIpv4 = await simulateBind(['127.0.0.1', '::1'], { fail: { '127.0.0.1': 'EADDRINUSE' }, ipv4Served: true });
  assert.equal(busyIpv4.ok, false);
});

test('optional hosts are skipped and an empty bind set fails', async () => {
  const skipped = await simulateBind(['127.0.0.1', '100.100.100.100'], { fail: { '100.100.100.100': 'EADDRNOTAVAIL' } });
  assert.equal(skipped.ok, true);
  assert.match(skipped.warnings.join('\n'), /Skipping bind 100\.100\.100\.100: EADDRNOTAVAIL/);
  const hard = await simulateBind(['127.0.0.1', '192.0.2.10'], { fail: { '192.0.2.10': 'EACCES' } });
  assert.equal(hard.ok, false);
  assert.equal(hard.err.code, 'EACCES');
  const none = await simulateBind(['::1', '0.0.0.0'], { fail: { '::1': 'EAFNOSUPPORT', '0.0.0.0': 'EACCES' } });
  assert.equal(none.ok, false);
});

const ownProbe = {
  port: 3456,
  probe: { localPort: 50123, remoteAddress: '127.0.0.1' },
  incoming: { remoteAddress: '::ffff:127.0.0.1', remotePort: 50123, localPort: 3456 },
};
const withIncoming = extra => ({ ...ownProbe, incoming: { ...ownProbe.incoming, ...extra } });
const withProbe = extra => ({ ...ownProbe, probe: { ...ownProbe.probe, ...extra } });

test('IPv4 loopback probe is ours only when the full tuple matches', () => {
  assert.equal(isOwnIpv4LoopbackProbe(ownProbe), true);
  assert.equal(isOwnIpv4LoopbackProbe(withIncoming({ remoteAddress: '127.0.0.1' })), true);
});

test('IPv4 loopback probe mismatches are not ours', () => {
  assert.equal(isOwnIpv4LoopbackProbe(withIncoming({ remoteAddress: '192.0.2.10' })), false);
  assert.equal(isOwnIpv4LoopbackProbe(withIncoming({ remoteAddress: '::1' })), false);
  assert.equal(isOwnIpv4LoopbackProbe(withIncoming({ remoteAddress: undefined })), false);
  assert.equal(isOwnIpv4LoopbackProbe(withIncoming({ remotePort: 50124 })), false);
  assert.equal(isOwnIpv4LoopbackProbe(withIncoming({ localPort: 3457 })), false);
  assert.equal(isOwnIpv4LoopbackProbe(withProbe({ remoteAddress: '::1' })), false);
  assert.equal(isOwnIpv4LoopbackProbe(withProbe({ remoteAddress: undefined })), false);
  assert.equal(isOwnIpv4LoopbackProbe(withProbe({ localPort: undefined })), false);
  assert.equal(isOwnIpv4LoopbackProbe(withIncoming({ remotePort: undefined })), false);
});
