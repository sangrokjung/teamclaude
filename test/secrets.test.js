import test from 'node:test';
import assert from 'node:assert/strict';
import { containsSecret, redactSecrets } from '../src/secrets.js';

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const OPAQUE = 'Q2xvdWRIYW5kb2ZmT3BhcXVlVG9rZW4xMjM0NTY3ODkwYWJjZGVmZ2hpams0NTY3';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const UUID = '0a1b2c3d-1111-4222-8333-444455556666';

test('redactSecrets removes JWTs, Authorization values of any scheme, and long opaque tokens', () => {
  for (const [input, secret] of [
    [`token is ${JWT} ok`, JWT],
    ['Authorization: Token abc123DEF456', 'abc123DEF456'],
    ['authorization: Digest username="u", response="6629fae49393a053"', '6629fae49393a053'],
    ['{"Authorization": "Custom zz99yy88"}', 'zz99yy88'],
    [`blob ${OPAQUE} end`, OPAQUE],
    [`k=${OPAQUE}`, OPAQUE],
    ['tok AbC9dEf8GhI7jKl6MnO5pQr4-StU3vWx2YzA1bCd0EfG9hIj end', 'AbC9dEf8GhI7jKl6MnO5pQr4-StU3vWx2YzA1bCd0EfG9hIj'],
  ]) {
    const out = redactSecrets(input);
    assert.equal(out.includes(secret), false, input);
    assert.match(out, /\[REDACTED/, input);
  }
});

test('redactSecrets keeps git SHAs, UUIDs, paths, and ordinary prose', () => {
  for (const input of [
    `commit ${SHA}`,
    `session ${UUID}`,
    `session-${UUID}`,
    `transcripts/${UUID}.jsonl`,
    'src/components/dashboard2/widgets/AccountUsageTable3.tsx',
    'packages/server/src/handlers/v2/accounts/refreshLapsedTokens2.js',
    'integrity sha512-Q2xvdWRIYW5kb2ZmT3BhcXVlVG9rZW4xMjM0NTY3ODkwYWJjZGVmZ2hpams0NTY3QQ==',
    'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz',
    '배포 이어서 해줘',
    'fix-account-selection-when-all-accounts-exhausted-2',
    'cloud_handoff_on_exhaustion_2026_10_14_spec_v2',
  ]) {
    assert.equal(redactSecrets(input), input, input);
  }
});

test('containsSecret flags env-style keys, JSON keys, JWTs, PEM keys, and provider tokens', () => {
  for (const input of [
    'OPENAI_API_KEY=Zk3q9LmP0xR7tYvW2bN5cD8eF1gH4jK6aS9dQ2wE',
    'export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    '"client_secret": "a8f7d6e5c4b3a2918f7e6d5c"',
    "  password: 'Tr0ub4dor&3horsebattery'",
    `const t = "${JWT}";`,
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'Authorization: Bearer abcdef0123456789abcdef',
    `blob ${OPAQUE}`,
  ]) {
    assert.equal(containsSecret(input), true, input);
  }
});

test('containsSecret ignores placeholders and ordinary code', () => {
  for (const input of [
    'OPENAI_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxx',
    'OPENAI_API_KEY=<your-openai-api-key-here>',
    'OPENAI_API_KEY=${OPENAI_API_KEY_FROM_VAULT}',
    'DB_PASSWORD=changeme-changeme-changeme',
    '"api_key": "example-api-key-value-123"',
    'API_KEY=your_api_key_goes_here_1234',
    'const token = await refreshAccessToken(account);',
    'headers: { Authorization: `Bearer ${accessToken}` },',
    'const apiKey = config.providers.openaiCompatible;',
    '"keyboard_shortcut_title": "Press the key to continue"',
    'send a Bearer token in the header',
    `commit ${SHA} and session ${UUID}`,
    'plain text without secrets',
  ]) {
    assert.equal(containsSecret(input), false, input);
  }
});

test('secret detection stays linear on pathological megabyte inputs', () => {
  const size = 1024 * 1024;
  for (const input of [
    'a'.repeat(size),
    'a-'.repeat(size / 2),
    `"${'a'.repeat(size)}`,
    'token_'.repeat(size / 6),
    `x${'=a'.repeat(size / 2)}`,
  ]) {
    const started = Date.now();
    containsSecret(input);
    redactSecrets(input);
    assert.ok(Date.now() - started < 3000, `${input.slice(0, 8)}… took ${Date.now() - started}ms`);
  }
});
