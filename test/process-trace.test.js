import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  formatLocalTimestamp,
  prefixLines,
  installTimestampedConsole,
  formatSignalTrace,
  formatSupervisorExitTrace,
  formatWorkerShutdownTrace,
  maskSecrets,
  filterPsSnapshot,
  clampSnapshotTimeout,
  captureProcessSnapshot,
  PS_MATCH,
} from '../src/process-trace.js';

const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2} /;

function withTZ(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
}

// ── timestamp ───────────────────────────────────────────────

test('formatLocalTimestamp renders local wall time with ms and a positive offset', () => {
  const stamp = withTZ('Asia/Seoul', () => formatLocalTimestamp(new Date(Date.UTC(2026, 9, 9, 12, 40, 1, 7))));
  assert.equal(stamp, '2026-10-09T21:40:01.007+09:00');
});

test('formatLocalTimestamp renders a negative offset', () => {
  const stamp = withTZ('America/New_York', () => formatLocalTimestamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 600))));
  assert.equal(stamp, '2026-01-01T22:04:05.600-05:00');
});

test('formatLocalTimestamp round-trips through Date parsing', () => {
  const date = new Date(1_791_000_000_123);
  assert.equal(new Date(formatLocalTimestamp(date)).getTime(), date.getTime());
});

test('prefixLines stamps every line, including blank ones, without trailing spaces', () => {
  assert.equal(prefixLines('a\n\nb', 'T'), 'T a\nT\nT b');
  assert.equal(prefixLines('', 'T'), 'T');
});

// ── console wrapper ─────────────────────────────────────────

function fakeConsole() {
  const calls = [];
  const target = {};
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    target[method] = (...args) => calls.push({ method, args });
  }
  return { target, calls };
}

test('installTimestampedConsole prefixes every console method line by line', () => {
  const { target, calls } = fakeConsole();
  const now = () => new Date(1_791_000_000_000);
  const uninstall = installTimestampedConsole({ target, now });
  target.log('\n[TeamClaude] Shutting down...');
  target.error('x=%d %s', 5, 'y');
  target.log();
  const stamp = formatLocalTimestamp(now());
  assert.deepEqual(calls[0], { method: 'log', args: ['%s', `${stamp}\n${stamp} [TeamClaude] Shutting down...`] });
  assert.deepEqual(calls[1], { method: 'error', args: ['%s', `${stamp} x=5 y`] });
  assert.deepEqual(calls[2], { method: 'log', args: ['%s', stamp] });
  uninstall();
  target.log('plain');
  assert.deepEqual(calls[3], { method: 'log', args: ['plain'] });
});

test('installTimestampedConsole is idempotent (never double-stamps)', () => {
  const { target, calls } = fakeConsole();
  const first = installTimestampedConsole({ target, now: () => new Date(0) });
  const second = installTimestampedConsole({ target, now: () => new Date(0) });
  assert.equal(first, second);
  target.log('once');
  assert.equal(calls.length, 1);
  assert.equal((calls[0].args[1].match(/T\d{2}:/g) || []).length, 1);
  first();
});

test('installTimestampedConsole does not re-interpret percent signs in the formatted text', () => {
  const { target, calls } = fakeConsole();
  const uninstall = installTimestampedConsole({ target, now: () => new Date(0) });
  target.log('100%s done');
  assert.equal(calls[0].args[0], '%s');
  assert.match(calls[0].args[1], /100%s done$/);
  uninstall();
});

// ── signal / exit lines ─────────────────────────────────────

test('formatSignalTrace reports signal, pid, ppid, uptime and inflight', () => {
  const line = formatSignalTrace({
    role: 'Supervisor', signal: 'SIGTERM', pid: 100, ppid: 1, uptimeSec: 3723.456, inflight: 4, workerPid: 101,
  });
  assert.equal(line,
    '[TeamClaude] Supervisor received SIGTERM pid=100 ppid=1 uptime=3723.5s inflight=4 workerPid=101');
});

test('formatSignalTrace marks unknown inflight and omits a missing worker pid', () => {
  const line = formatSignalTrace({ role: 'Supervisor', signal: 'SIGHUP', pid: 7, ppid: 1, uptimeSec: 0.04, inflight: null });
  assert.equal(line, '[TeamClaude] Supervisor received SIGHUP pid=7 ppid=1 uptime=0.0s inflight=n/a');
});

test('formatSupervisorExitTrace reports reason and code', () => {
  assert.equal(
    formatSupervisorExitTrace({ reason: 'signal:SIGTERM', code: 0, pid: 100, uptimeSec: 12 }),
    '[TeamClaude] Supervisor exiting reason=signal:SIGTERM code=0 pid=100 uptime=12.0s',
  );
  assert.equal(
    formatSupervisorExitTrace({ reason: undefined, code: undefined, pid: 1, uptimeSec: 1 }),
    '[TeamClaude] Supervisor exiting reason=unspecified code=0 pid=1 uptime=1.0s',
  );
});

test('formatWorkerShutdownTrace distinguishes IPC disconnect from a delivered signal', () => {
  assert.equal(
    formatWorkerShutdownTrace({
      signal: 'SIGTERM', source: 'ipc-disconnect', pid: 9, ppid: 8, supervisorPid: '8', ipcConnected: false,
    }),
    '[TeamClaude] Worker shutting down on SIGTERM source=ipc-disconnect pid=9 ppid=8 supervisorPid=8 ipc=disconnected',
  );
  assert.equal(
    formatWorkerShutdownTrace({
      signal: 'SIGINT', source: 'signal', pid: 9, ppid: 1, supervisorPid: undefined, ipcConnected: true,
    }),
    '[TeamClaude] Worker shutting down on SIGINT source=signal pid=9 ppid=1 supervisorPid=n/a ipc=connected',
  );
});

// ── masking ─────────────────────────────────────────────────

test('maskSecrets hides Anthropic keys, bearer tokens and long base64-like runs', () => {
  const masked = maskSecrets(
    'claude --key sk-ant-oat01-AbCdEf123_xyz-QQ -H "Authorization: Bearer eyJhbGciOi.J9abc" '
    + 'QWxhZGRpbjpvcGVuIHNlc2FtZQ0K1234567890abcdEF '
    + 'ab12CD34ef56/GH78ij90KL12mn34OP56qr78ST90uv+w== '
    + '0123456789abcdef0123456789abcdef01234567',
  );
  assert.ok(masked.includes('sk-ant-***'), masked);
  assert.ok(!masked.includes('AbCdEf123'), masked);
  assert.ok(masked.includes('Bearer ***'), masked);
  assert.ok(!masked.includes('eyJhbGciOi'), masked);
  assert.ok(!masked.includes('QWxhZGRpbjpvcGVu'), masked);
  assert.ok(!masked.includes('GH78ij90'), masked);
  assert.ok(!masked.includes('0123456789abcdef0123'), masked);
});

test('maskSecrets keeps ordinary paths and launchctl targets readable', () => {
  const cmds = [
    '/usr/local/lib/node_modules/teamcodex/src/index.js server',
    'launchctl kickstart -k gui/501/com.example.teamclaude',
    '/opt/homebrew/Cellar/node/24.1.0/bin/node /opt/lib/node_modules/teamcodex/src/index.js',
    'kill -TERM 12345',
  ];
  for (const cmd of cmds) assert.equal(maskSecrets(cmd), cmd);
});

test('maskSecrets masks a slash-free segment inside an absolute path that looks like a token', () => {
  const masked = maskSecrets('/tmp/QWxhZGRpbjpvcGVuIHNlc2FtZQ0K1234567890abcdEF/file');
  assert.equal(masked, '/tmp/***/file');
});

// ── ps filtering ────────────────────────────────────────────

const PS_SAMPLE = [
  '    1     0 Mon Oct  5 12:00:00 2026     /sbin/launchd',
  '  500     1 Sat Oct 10 21:39:58 2026     /usr/local/bin/node /usr/local/lib/node_modules/teamcodex/src/index.js server',
  '  777   650 Sat Oct 10 21:40:01 2026     launchctl kickstart -k gui/501/com.example.teamclaude',
  '  778   650 Sat Oct 10 21:40:01 2026     /bin/zsh -c claude --token sk-ant-oat01-SECRETSECRET123',
  '  779   650 Sat Oct 10 21:40:01 2026     /usr/bin/pkill -f something',
  '  780   650 Sat Oct 10 21:40:01 2026     vim notes.txt',
  'garbage line',
  '',
].join('\n');

test('PS_MATCH selects launchctl/kickstart/teamclaude/teamcodex/kill commands only', () => {
  assert.ok(PS_MATCH.test('launchctl kickstart -k x'));
  assert.ok(PS_MATCH.test('node teamclaude server'));
  assert.ok(PS_MATCH.test('pkill -f foo'));
  assert.ok(!PS_MATCH.test('vim notes.txt'));
});

test('filterPsSnapshot keeps matching rows as pid/ppid/start/cmd and masks secrets', () => {
  const { lines, total } = filterPsSnapshot(PS_SAMPLE);
  assert.equal(total, 3);
  assert.deepEqual(lines, [
    'pid=500 ppid=1 start="Sat Oct 10 21:39:58 2026" cmd=/usr/local/bin/node /usr/local/lib/node_modules/teamcodex/src/index.js server',
    'pid=777 ppid=650 start="Sat Oct 10 21:40:01 2026" cmd=launchctl kickstart -k gui/501/com.example.teamclaude',
    'pid=779 ppid=650 start="Sat Oct 10 21:40:01 2026" cmd=/usr/bin/pkill -f something',
  ]);
});

test('filterPsSnapshot masks before matching output and truncates the command to 160 chars', () => {
  const longCmd = `/usr/local/bin/teamclaude ${'a'.repeat(300)}`;
  const raw = `  42     1 Sat Oct 10 21:40:01 2026     ${longCmd}\n`
    + '  43     1 Sat Oct 10 21:40:01 2026     teamcodex --token sk-ant-oat01-SECRETSECRET123\n';
  const { lines } = filterPsSnapshot(raw);
  const cmd0 = lines[0].split(' cmd=')[1];
  assert.equal(cmd0.length, 160);
  assert.ok(longCmd.startsWith(cmd0));
  assert.ok(lines[1].endsWith('cmd=teamcodex --token sk-ant-***'), lines[1]);
});

test('filterPsSnapshot caps the number of rows', () => {
  const raw = Array.from({ length: 10 }, (_, i) =>
    `  ${100 + i}     1 Sat Oct 10 21:40:01 2026     teamclaude worker ${i}`).join('\n');
  const { lines, total } = filterPsSnapshot(raw, { maxLines: 3 });
  assert.equal(lines.length, 3);
  assert.equal(total, 10);
});

// ── async snapshot ──────────────────────────────────────────

test('clampSnapshotTimeout never exceeds one second', () => {
  assert.equal(clampSnapshotTimeout(5000), 1000);
  assert.equal(clampSnapshotTimeout(250), 250);
  assert.equal(clampSnapshotTimeout(undefined), 1000);
  assert.equal(clampSnapshotTimeout(0), 1);
});

function fakeSpawn({ output = '', code = 0, delayMs = 0, error = null, neverExit = false } = {}) {
  const calls = [];
  const spawnImpl = (cmd, argv, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.unref = () => { child.unrefd = true; };
    child.kill = signal => { child.killed = signal; return true; };
    calls.push({ cmd, argv, opts, child });
    setTimeout(() => {
      if (error) { child.emit('error', error); return; }
      if (neverExit) return;
      child.stdout.end(output);
      child.exitCode = code;
      child.emit('close', code, null);
    }, delayMs);
    return child;
  };
  return { spawnImpl, calls };
}

test('captureProcessSnapshot resolves filtered rows from ps output', async () => {
  const { spawnImpl, calls } = fakeSpawn({ output: PS_SAMPLE });
  const result = await captureProcessSnapshot({ spawnImpl });
  assert.equal(result.ok, true);
  assert.equal(result.total, 3);
  assert.equal(result.lines.length, 3);
  assert.equal(calls[0].cmd, 'ps');
  assert.deepEqual(calls[0].argv, ['-axo', 'pid=,ppid=,lstart=,command=']);
  assert.equal(calls[0].opts.env.LC_ALL, 'C');
  assert.equal(calls[0].child.unrefd, true, 'the ps child must not hold the event loop open');
});

test('captureProcessSnapshot gives up at the timeout and kills ps', async () => {
  const { spawnImpl, calls } = fakeSpawn({ neverExit: true });
  const started = Date.now();
  const result = await captureProcessSnapshot({ spawnImpl, timeoutMs: 50 });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out after 50ms/);
  assert.ok(Date.now() - started < 900);
  assert.equal(calls[0].child.killed, 'SIGKILL');
});

test('captureProcessSnapshot never rejects on spawn failure or a ps error', async () => {
  const thrown = await captureProcessSnapshot({ spawnImpl: () => { throw new Error('EAGAIN'); } });
  assert.deepEqual(thrown, { ok: false, error: 'EAGAIN', lines: [], total: 0 });
  const { spawnImpl } = fakeSpawn({ error: new Error('spawn ps ENOENT') });
  const errored = await captureProcessSnapshot({ spawnImpl });
  assert.equal(errored.ok, false);
  assert.match(errored.error, /ENOENT/);
  const { spawnImpl: failing } = fakeSpawn({ code: 1 });
  const nonzero = await captureProcessSnapshot({ spawnImpl: failing });
  assert.equal(nonzero.ok, false);
  assert.match(nonzero.error, /ps exited 1/);
});

test('captureProcessSnapshot against the real ps settles within the bound', async () => {
  const started = Date.now();
  const result = await captureProcessSnapshot({ timeoutMs: 1000 });
  assert.ok(Date.now() - started < 1500);
  assert.equal(typeof result.ok, 'boolean');
  assert.ok(Array.isArray(result.lines));
  for (const line of result.lines) assert.match(line, /^pid=\d+ ppid=\d+ start="[^"]+" cmd=/);
});

test('timestamped lines match the documented prefix shape', () => {
  assert.match(prefixLines('x', formatLocalTimestamp()), STAMP_RE);
});
