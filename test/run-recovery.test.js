import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.js');

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    resolve(server.address().port);
  }));
}

function runCli(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], options);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out\n${stdout}\n${stderr}`));
    }, 8000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function jsonLines(path) {
  const raw = await readFile(path, 'utf8').catch(() => '');
  return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('real run command resumes Claude then hands an exhausted fleet to Codex exactly once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teamclaude-run-recovery-'));
  const bin = join(root, 'bin');
  const project = join(root, 'project');
  const configDir = join(root, '.config');
  const claudeCalls = join(root, 'claude-calls.jsonl');
  const codexCalls = join(root, 'codex-calls.jsonl');
  await mkdir(bin);
  await mkdir(project);
  await mkdir(configDir);

  const fakeClaude = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_CALLS, JSON.stringify(args) + '\\n');
const flag = args.findIndex(arg => arg === '--session-id');
if (flag >= 0) {
  const sessionId = args[flag + 1];
  const dir = join(process.env.HOME, '.claude', 'projects', 'fake');
  mkdirSync(dir, { recursive: true });
  const records = [
    { type: 'user', cwd: process.cwd(), gitBranch: 'test/recovery', message: { role: 'user', content: 'finish the recovery test' } },
    { type: 'assistant', cwd: process.cwd(), isApiErrorMessage: true, error: 'server_error', message: { role: 'assistant', content: [{ type: 'text', text: 'Request timed out' }] } },
  ];
  writeFileSync(join(dir, sessionId + '.jsonl'), records.map(JSON.stringify).join('\\n') + '\\n');
  process.on('SIGTERM', () => process.exit(0));
  setInterval(() => {}, 1000);
}
`;
  const fakeCodex = `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_CODEX_CALLS, JSON.stringify(process.argv.slice(2)) + '\\n');
`;
  await writeFile(join(bin, 'claude'), fakeClaude, { mode: 0o755 });
  await writeFile(join(bin, 'codex'), fakeCodex, { mode: 0o755 });

  let utilization = 0.5;
  const statusServer = http.createServer((req, res) => {
    if (req.url !== '/teamclaude/status') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      switchThreshold: 0.98,
      accounts: [{
        enabled: true,
        status: 'active',
        quota: {
          unified7d: utilization,
          unified7dReset: new Date(Date.now() + 60_000).toISOString(),
        },
      }],
    }));
  });
  const port = await listen(statusServer);

  const baseConfig = {
    proxy: { port, apiKey: 'test-proxy-key' },
    upstream: 'http://127.0.0.1:9',
    switchThreshold: 0.98,
    autoResumeClaude: true,
    claudeAutoResumeMaxRetries: 1,
    claudeAutoResumeBackoffMs: 0,
    codexFallbackOnExhaustion: true,
    accounts: [],
  };
  await writeFile(join(configDir, 'teamclaude.json'), JSON.stringify(baseConfig));
  await writeFile(join(configDir, 'teamcodex.json'), JSON.stringify({
    ...baseConfig,
    provider: 'codex',
    codexFallbackOnExhaustion: false,
  }));

  const env = {
    ...process.env,
    HOME: root,
    XDG_CONFIG_HOME: configDir,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_CLAUDE_CALLS: claudeCalls,
    FAKE_CODEX_CALLS: codexCalls,
  };
  delete env.TEAMCLAUDE_CONFIG;
  delete env.TEAMCLAUDE_PROVIDER;

  try {
    const resumed = await runCli(['run'], {
      cwd: project,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(resumed.status, 0, resumed.stderr);
    const resumedCalls = await jsonLines(claudeCalls);
    assert.equal(resumedCalls.length, 2);
    const sessionId = resumedCalls[0][resumedCalls[0].indexOf('--session-id') + 1];
    assert.deepEqual(resumedCalls[1], ['--resume', sessionId, 'continue']);
    assert.deepEqual(await jsonLines(codexCalls), []);

    await writeFile(claudeCalls, '');
    utilization = 0.98;
    const handedOff = await runCli(['run'], {
      cwd: project,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(handedOff.status, 0, handedOff.stderr);
    assert.equal((await jsonLines(claudeCalls)).length, 1);
    const codex = await jsonLines(codexCalls);
    assert.equal(codex.length, 1);
    assert.ok(codex[0].some(arg => arg.includes('teamclaude-handoffs')));
    const handoffs = await readdir(join(configDir, 'teamclaude-handoffs'));
    assert.equal(handoffs.length, 1);
  } finally {
    statusServer.close();
  }
});
