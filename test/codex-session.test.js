import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCmuxEnv, parseCmuxCodexBaseline } from '../src/codex-session.js';

const SESSION_ID = '01900000-0000-7000-8000-000000000011';

test('cmux checkpoint lookup does not inherit direct Codex credentials', () => {
  const env = buildCmuxEnv({
    PATH: '/usr/bin',
    CMUX_WORKSPACE_ID: 'workspace',
    OPENAI_API_KEY: 'value',
    CODEX_API_KEY: 'value',
    CODEX_ACCESS_TOKEN: 'value',
    TEAMCLAUDE_CODEX_PROXY_TOKEN: 'value',
  });

  assert.deepEqual(env, {
    PATH: '/usr/bin',
    CMUX_WORKSPACE_ID: 'workspace',
  });
});

test('cmux baseline distinguishes an empty surface from malformed bindings', () => {
  assert.deepEqual(parseCmuxCodexBaseline({}), { trusted: true, sessionId: null });
  assert.deepEqual(
    parseCmuxCodexBaseline({
      resume_binding: { kind: 'codex', checkpoint_id: SESSION_ID },
    }),
    { trusted: true, sessionId: SESSION_ID },
  );
  assert.deepEqual(
    parseCmuxCodexBaseline({ resume_binding: { kind: 'codex', checkpoint_id: 'last' } }),
    { trusted: false, sessionId: null },
  );
  assert.deepEqual(parseCmuxCodexBaseline([]), { trusted: false, sessionId: null });
});
