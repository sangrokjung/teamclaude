import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCmuxEnv } from '../src/codex-session.js';

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
