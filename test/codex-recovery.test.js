import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_INVOCATION_HEADER,
  codexRecoveryIdentity,
  isCodexInvocationId,
  isCodexResponsesPath,
} from '../src/codex-recovery.js';

const INVOCATION_ID = '01900000-0000-4000-8000-000000000020';
const SESSION_ID = '01900000-0000-7000-8000-000000000021';

test('codexRecoveryIdentity binds a valid invocation UUID to prompt_cache_key', () => {
  assert.equal(isCodexInvocationId(INVOCATION_ID), true);
  assert.deepEqual(
    codexRecoveryIdentity(
      { [CODEX_INVOCATION_HEADER]: INVOCATION_ID },
      JSON.stringify({ prompt_cache_key: SESSION_ID }),
    ),
    { invocationId: INVOCATION_ID, sessionId: SESSION_ID },
  );
});

test('codexRecoveryIdentity rejects malformed invocation, body, and session boundaries', () => {
  const scenarios = [
    [{}, JSON.stringify({ prompt_cache_key: SESSION_ID })],
    [{ [CODEX_INVOCATION_HEADER]: SESSION_ID }, JSON.stringify({ prompt_cache_key: SESSION_ID })],
    [{ [CODEX_INVOCATION_HEADER]: INVOCATION_ID }, '{not-json'],
    [{ [CODEX_INVOCATION_HEADER]: INVOCATION_ID }, JSON.stringify({})],
    [{ [CODEX_INVOCATION_HEADER]: INVOCATION_ID }, JSON.stringify({ prompt_cache_key: 'last' })],
    [{ [CODEX_INVOCATION_HEADER]: INVOCATION_ID }, JSON.stringify({ prompt_cache_key: [SESSION_ID] })],
  ];

  for (const [headers, body] of scenarios) {
    assert.equal(codexRecoveryIdentity(headers, body), null);
  }
});

test('isCodexResponsesPath accepts only the inference endpoint', () => {
  assert.equal(isCodexResponsesPath('/codex/responses'), true);
  assert.equal(isCodexResponsesPath('/codex/responses?trace=1'), true);
  assert.equal(isCodexResponsesPath('/responses/'), true);
  assert.equal(isCodexResponsesPath('/codex/responses/input_tokens'), false);
  assert.equal(isCodexResponsesPath('/codex/not-responses'), false);
  assert.equal(isCodexResponsesPath('/v1/messages'), false);
});
