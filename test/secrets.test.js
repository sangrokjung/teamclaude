import test from 'node:test';
import assert from 'node:assert/strict';
import { containsSecret, redactSecrets } from '../src/secrets.js';
import {
  GIT_SHA,
  JWT,
  OPAQUE,
  assign,
  pemFooter,
  pemHeader,
  seededToken,
} from './helpers/secret-fixtures.js';

const SHA = GIT_SHA;
const DASHED_TOKEN = [seededToken(24, 3), seededToken(24, 4)].join('-');
const UUID = '0a1b2c3d-1111-4222-8333-444455556666';

test('redactSecrets removes JWTs, Authorization values of any scheme, and long opaque tokens', () => {
  for (const [input, secret] of [
    [`token is ${JWT} ok`, JWT],
    ['Authorization: Token abc123DEF456', 'abc123DEF456'],
    ['authorization: Digest username="u", response="6629fae49393a053"', '6629fae49393a053'],
    ['{"Authorization": "Custom zz99yy88"}', 'zz99yy88'],
    [`blob ${OPAQUE} end`, OPAQUE],
    [`k=${OPAQUE}`, OPAQUE],
    [`tok ${DASHED_TOKEN} end`, DASHED_TOKEN],
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
    `integrity sha512-${seededToken(86, 5)}==`,
    'abcdefghijklmnopqrstuvwxyz'.repeat(2),
    '배포 이어서 해줘',
    ['fix', 'account', 'selection', 'when', 'all', 'accounts', 'exhausted', '2'].join('-'),
    ['cloud', 'handoff', 'on', 'exhaustion', '2026', '10', '14', 'spec', 'v2'].join('_'),
  ]) {
    assert.equal(redactSecrets(input), input, input);
  }
});

test('containsSecret flags env-style keys, JSON keys, JWTs, PEM keys, and provider tokens', () => {
  for (const input of [
    assign('OPENAI_API_KEY', seededToken(40, 11)),
    `export ${assign('GITHUB_TOKEN', ['gh', 'p_', seededToken(36, 9)].join(''))}`,
    `"client_secret": "${['a8f7d6e5c4b3', 'a2918f7e6d5c'].join('')}"`,
    `  password: '${['Tr0ub4dor', '&3horsebattery'].join('')}'`,
    `const t = "${JWT}";`,
    `${pemHeader('RSA')}\nMIIEow\n${pemFooter('RSA')}`,
    pemHeader('OPENSSH'),
    `Authorization: Bearer ${['abcdef0123', '456789abcdef'].join('')}`,
    `blob ${OPAQUE}`,
  ]) {
    assert.equal(containsSecret(input), true, input);
  }
});

test('containsSecret ignores placeholders and ordinary code', () => {
  for (const input of [
    assign('OPENAI_API_KEY', 'x'.repeat(24)),
    assign('OPENAI_API_KEY', '<your-openai-api-key-here>'),
    assign('OPENAI_API_KEY', '${OPENAI_API_KEY_FROM_VAULT}'),
    assign('DB_PASSWORD', 'changeme-changeme-changeme'),
    '"api_key": "example-api-key-value-123"',
    assign('API_KEY', 'your_api_key_goes_here_1234'),
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

test('containsSecret flags Authorization headers of any scheme and letter-only YAML secrets', () => {
  const letters = 'QwErTyUiOpAsDfGhJkLzXcVbNmQwErTyUiOp';
  for (const input of [
    `Authorization: Token ${letters}`,
    `authorization = "Digest ${letters}"`,
    `"authorization": "${letters}"`,
    `api_token: ${letters}`,
  ]) {
    assert.equal(containsSecret(input), true, input);
  }
  assert.equal(containsSecret('Authorization: Token <your-token-here>'), false);
});
