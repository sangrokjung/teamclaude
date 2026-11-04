import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { isLoopbackAddress, isRemoteAuthorized } from '../src/proxy-auth.js';

const remote = { isLocal: false, clientKey: undefined, bearerKey: null };

test('rejects remote when key is unset', () => {
  assert.equal(isRemoteAuthorized({ ...remote, proxyApiKey: undefined }), false);
  assert.equal(isRemoteAuthorized({ ...remote, proxyApiKey: null, clientKey: 'anything' }), false);
});

test('rejects remote when key is an empty string with empty headers', () => {
  assert.equal(isRemoteAuthorized({ isLocal: false, proxyApiKey: '', clientKey: '', bearerKey: '' }), false);
  assert.equal(isRemoteAuthorized({ isLocal: false, proxyApiKey: '', clientKey: undefined, bearerKey: null }), false);
});

test('rejects remote when key is not a string', () => {
  assert.equal(isRemoteAuthorized({ isLocal: false, proxyApiKey: 12345, clientKey: '12345', bearerKey: '12345' }), false);
});

test('accepts matching x-api-key', () => {
  assert.equal(isRemoteAuthorized({ ...remote, proxyApiKey: 'tc-secret', clientKey: 'tc-secret' }), true);
});

test('accepts matching bearer', () => {
  assert.equal(isRemoteAuthorized({ ...remote, proxyApiKey: 'tc-secret', bearerKey: 'tc-secret' }), true);
});

test('rejects wrong key', () => {
  assert.equal(isRemoteAuthorized({ isLocal: false, proxyApiKey: 'tc-secret', clientKey: 'nope', bearerKey: 'nope' }), false);
});

test('local bypass kept when key unset', () => {
  assert.equal(isRemoteAuthorized({ isLocal: true, proxyApiKey: undefined, clientKey: undefined, bearerKey: null }), true);
  assert.equal(isRemoteAuthorized({ isLocal: true, proxyApiKey: '', clientKey: undefined, bearerKey: null }), true);
});

test('loopback classification', () => {
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAddress(addr), true, addr);
  }
  for (const addr of ['192.0.2.10', '::ffff:192.0.2.10', '0.0.0.0', undefined]) {
    assert.equal(isLoopbackAddress(addr), false, String(addr));
  }
});

test('no fail-open key guard remains', async () => {
  const pattern = /if \((proxyApiKey|config\.proxy\?\.apiKey) && clientKey !==/;
  for (const rel of ['../src/server.js', '../src/index.js']) {
    const source = await readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    assert.doesNotMatch(source, pattern, rel);
  }
});
