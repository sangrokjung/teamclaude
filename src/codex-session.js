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
const BLOCKED_CODEX_RESUME_OPTIONS = new Set([
  '--remote',
  '--remote-auth-token-env',
  '--oss',
  '--local-provider',
]);
const BLOCKED_CODEX_CONFIG_ROOTS = [
  'model_provider',
  'model_providers',
  'chatgpt_base_url',
];

function decodeTomlBasicKeySegments(value) {
  let invalid = false;
  const decoded = value.replace(/"(?:\\.|[^"\\])*"/g, segment => {
    try {
      const jsonCompatible = segment.replace(
        /\\U([0-9a-f]{8})/gi,
        (_, hex) => {
          const codePoint = Number.parseInt(hex, 16);
          if (
            codePoint > 0x10ffff
            || (codePoint >= 0xd800 && codePoint <= 0xdfff)
          ) {
            throw new RangeError('Invalid TOML Unicode escape');
          }
          return JSON.stringify(String.fromCodePoint(codePoint)).slice(1, -1);
        },
      );
      if (jsonCompatible.includes('\\/')) {
        throw new SyntaxError('Invalid TOML escape');
      }
      return JSON.parse(jsonCompatible);
    } catch {
      invalid = true;
      return segment;
    }
  });
  return invalid ? null : decoded;
}

export function isCodexSessionId(value) {
  return typeof value === 'string' && CODEX_SESSION_ID.test(value);
}

export function parseCmuxCodexSessionId(value) {
  const binding = value?.resume_binding;
  return binding?.kind === 'codex' && isCodexSessionId(binding.checkpoint_id)
    ? binding.checkpoint_id
    : null;
}

export function findBlockedCodexRouteOption(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    const option = arg.split('=', 1)[0];
    if (BLOCKED_CODEX_RESUME_OPTIONS.has(option)) return option;

    let configValue = null;
    if (arg === '-c' || arg === '--config') {
      configValue = args[i + 1];
      i += 1;
    } else if (arg.startsWith('--config=')) {
      configValue = arg.slice('--config='.length);
    } else if (arg.startsWith('-c') && arg.length > 2) {
      configValue = arg.slice(2);
    }
    if (typeof configValue !== 'string') continue;
    if (configValue.startsWith('=')) configValue = configValue.slice(1);
    const rawConfigKey = configValue.split('=', 1)[0];
    const decodedConfigKey = decodeTomlBasicKeySegments(rawConfigKey);
    if (decodedConfigKey === null) return 'escaped config key';
    const configKey = decodedConfigKey.replace(/[\s"'[\]]/g, '');
    const blockedRoot = BLOCKED_CODEX_CONFIG_ROOTS.find(
      root => configKey === root || configKey.startsWith(`${root}.`),
    );
    if (blockedRoot) return blockedRoot;
  }
  return null;
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
