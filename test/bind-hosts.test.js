import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listenBindHosts, resolveBindHosts } from '../src/bind-hosts.js';

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
