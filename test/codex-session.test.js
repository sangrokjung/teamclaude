import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCmuxEnv,
  findBlockedCodexRouteOption,
} from '../src/codex-session.js';

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

test('Codex resume rejects options that can bypass the TeamCodex route', () => {
  const cases = [
    [['--remote', 'wss://example.invalid'], '--remote'],
    [['--remote=wss://example.invalid'], '--remote'],
    [['--remote-auth-token-env', 'REMOTE_TOKEN_NAME'], '--remote-auth-token-env'],
    [['--remote-auth-token-env=REMOTE_TOKEN_NAME'], '--remote-auth-token-env'],
    [['--oss'], '--oss'],
    [['--local-provider', 'ollama'], '--local-provider'],
    [['--local-provider=ollama'], '--local-provider'],
    [['-c', 'model_provider="openai"'], 'model_provider'],
    [['--config', 'chatgpt_base_url="https://example.invalid"'], 'chatgpt_base_url'],
    [[
      '--config=model_providers.teamcodex_proxy={}',
    ], 'model_providers'],
    [[
      '-c',
      'model_providers.teamcodex_proxy.base_url="https://example.invalid"',
    ], 'model_providers'],
    [['-c', '"model_provider"="openai"'], 'model_provider'],
    [[
      '-c',
      'model_providers . "teamcodex_proxy" . base_url="https://example.invalid"',
    ], 'model_providers'],
    [['-c"model_provider"="openai"'], 'model_provider'],
    [['-c=model_provider="openai"'], 'model_provider'],
    [['-c', '"model\\u005fprovider"="openai"'], 'escaped config key'],
  ];

  for (const [args, expected] of cases) {
    assert.equal(findBlockedCodexRouteOption(args), expected);
  }
  assert.equal(findBlockedCodexRouteOption(['--model', 'gpt-5']), null);
});
