import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const CODEX_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIRECT_CODEX_CREDENTIALS = [
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'TEAMCLAUDE_CODEX_PROXY_TOKEN',
];

export function isCodexSessionId(value) {
  return typeof value === 'string' && CODEX_SESSION_ID.test(value);
}

export function parseCmuxCodexSessionId(value) {
  const binding = value?.resume_binding;
  return binding?.kind === 'codex' && isCodexSessionId(binding.checkpoint_id)
    ? binding.checkpoint_id
    : null;
}

export function buildCmuxEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  for (const key of DIRECT_CODEX_CREDENTIALS) delete env[key];
  return env;
}

export async function currentCmuxCodexSessionId() {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      'cmux',
      ['surface', 'resume', 'get', '--json'],
      { timeout: 3000, env: buildCmuxEnv() },
    ));
  } catch {
    throw new Error(
      'Cannot read the current cmux surface. Pass SESSION_ID explicitly.',
    );
  }

  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error(
      'The current cmux surface returned an invalid resume binding. Pass SESSION_ID explicitly.',
    );
  }
  const sessionId = parseCmuxCodexSessionId(value);
  if (!sessionId) {
    throw new Error(
      'The current cmux surface has no trusted Codex checkpoint. Pass SESSION_ID explicitly.',
    );
  }
  return sessionId;
}
