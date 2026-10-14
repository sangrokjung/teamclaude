import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const entry = process.env.TEAMCLAUDE_TEST_ENTRY
  || join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve(server.address().port);
  }));
}

function runCli(args, options, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], options);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

test('real run enters supervised recovery when only cloudFallbackOnExhaustion is enabled', async t => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-cloud-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configDir = join(root, '.config');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  await mkdir(bin);
  await mkdir(project);
  await mkdir(configDir);

  // Writes a fleet-exhaustion record only when the launcher supervises the
  // session (it injects --session-id); exits by itself so an unsupervised
  // launch cannot hang the test.
  const fakeClaude = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify(args) + '\\n');
const flag = args.indexOf('--session-id');
if (flag < 0) process.exit(0);
const dir = join(process.env.HOME, '.claude', 'projects', 'fake');
mkdirSync(dir, { recursive: true });
const records = [
  { type: 'user', cwd: process.cwd(), message: { role: 'user', content: 'keep going' } },
  { type: 'assistant', cwd: process.cwd(), isApiErrorMessage: true, error: 'rate_limit_error', apiErrorStatus: 429,
    message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: Server is temporarily limiting requests (not your usage limit) · All 2 accounts exhausted. Retry in 3s.' }] } },
];
writeFileSync(join(dir, args[flag + 1] + '.jsonl'), records.map(JSON.stringify).join('\\n') + '\\n');
process.on('SIGTERM', () => process.exit(0));
setTimeout(() => process.exit(3), 1500);
`;
  await writeFile(join(bin, 'claude'), fakeClaude, { mode: 0o755 });

  const statusServer = http.createServer((req, res) => {
    res.writeHead(req.url === '/teamclaude/status' ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ switchThreshold: 0.98, accounts: [] }));
  });
  const port = await listen(statusServer);
  t.after(() => statusServer.close());

  const configPath = join(root, 'claude.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { port, apiKey: 'test-proxy-key' },
    upstream: 'http://127.0.0.1:9',
    switchThreshold: 0.98,
    autoResumeClaude: false,
    codexFallbackOnExhaustion: false,
    cloudFallbackOnExhaustion: true,
    accounts: [],
  }));

  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: configDir,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_CLAUDE_CALLS: claudeCalls,
    TEAMCLAUDE_CONFIG: configPath,
  };
  for (const key of [
    'TEAMCLAUDE_PROVIDER',
    'TEAMCLAUDE_CLAUDE_BIN',
    'TEAMCLAUDE_SESSION_SUPERVISED',
    'ANTHROPIC_BASE_URL',
    'CMUX_SURFACE_ID',
  ]) delete env[key];

  const result = await runCli(['run'], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const calls = (await readFile(claudeCalls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--session-id'), result.stderr);
  // TEAMCLAUDE_CLAUDE_BIN is unset, so the cloud precondition fails closed
  // and the session is preserved instead of launching through the wrapper.
  assert.match(result.stderr, /Cloud session handoff for [0-9a-f-]+ was not possible \(vendor-missing\)/);
});
