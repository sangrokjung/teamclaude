// Boundary proofs of the legacy cloud sidecar, all on in-memory stubs (no
// temp directories): pool membership from raw `ps -wwE` text, the supervisor
// lease, and the strict transcript-tail scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { provesDefaultPool, resolveSupervisorLease } from '../src/cloud-sidecar.js';
import { scanExhaustionTail, sameExhaustionEvent } from '../src/sidecar-transcript.js';

const SESSION_A = '0a1b2c3d-1111-4222-8333-444455556666';
const SESSION_B = '1b2c3d4e-2222-4333-9444-555566667777';
const SESSION_C = '2c3d4e5f-3333-4444-a555-666677778888';
const EVENT_UUID_A = '3d4e5f60-4444-4555-b666-777788889999';
const EVENT_UUID_B = '4e5f6071-5555-4666-8777-88889999aaaa';
const CMD = '/opt/node/bin/node /opt/teamclaude/src/index.js run';
const HOME_DIR = '/home/user';
const STARTED_AT_MS = new Date('Tue Oct 14 09:00:00 2026').getTime();

// ── provesDefaultPool ───────────────────────────────────────

const pool = text => provesDefaultPool(text, CMD, HOME_DIR).ok;

test('provesDefaultPool accepts a visible default-config env with exactly the sidecar HOME', () => {
  assert.equal(pool(`${CMD} PATH=/usr/bin HOME=${HOME_DIR} SHELL=/bin/zsh`), true);
  assert.equal(pool(`${CMD} PATH=/usr/bin HOME=${HOME_DIR}`), true);
  assert.equal(pool(`${CMD} HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=anthropic PATH=/usr/bin`), true);
  assert.equal(pool(`${CMD} HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=anthropic`), true);
  // A space inside an unrelated value is irrelevant.
  assert.equal(pool(`${CMD} PS1=a b HOME=${HOME_DIR} _=/usr/bin/env`), true);
});

test('provesDefaultPool rejects any config override key anywhere in the text', () => {
  assert.equal(pool(`${CMD} HOME=${HOME_DIR} TEAMCLAUDE_CONFIG=/cfg/teamclaude.json`), false);
  assert.equal(pool(`${CMD} HOME=${HOME_DIR} TEAMCLAUDE_CONFIG=/cfg/teamclaude.json archive/POOL=b.json`), false);
  assert.equal(pool(`${CMD} NOTE=xTEAMCLAUDE_CONFIG=/cfg/a.json HOME=${HOME_DIR}`), false);
  assert.equal(pool(`${CMD} --note TEAMCLAUDE_CONFIG=/cfg/a.json HOME=${HOME_DIR}`), false);
  assert.equal(pool(`${CMD} HOME=${HOME_DIR} XDG_CONFIG_HOME=/xdg`), false);
});

test('provesDefaultPool admits TEAMCLAUDE_PROVIDER only as one exact anthropic entry', () => {
  assert.equal(pool(`${CMD} HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=codex`), false);
  assert.equal(pool(`${CMD} HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=anthropicx`), false);
  assert.equal(pool(`${CMD} HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=`), false);
  assert.equal(pool(`${CMD} HOME=${HOME_DIR} NOTE=TEAMCLAUDE_PROVIDER=anthropic`), false);
  assert.equal(pool(`${CMD} HOME=${HOME_DIR} TEAMCLAUDE_PROVIDER=anthropic TEAMCLAUDE_PROVIDER=codex`), false);
});

test('provesDefaultPool requires exactly one HOME= equal to the sidecar HOME with a provable end', () => {
  // A lowercase token after the value may be part of HOME itself.
  assert.equal(pool(`${CMD} PATH=/usr/bin HOME=${HOME_DIR} archive=pool-b`), false);
  assert.equal(pool(`${CMD} PATH=/usr/bin HOME=${HOME_DIR} more PATH2=/x`), false);
  assert.equal(pool(`${CMD} PATH=/usr/bin HOME=${HOME_DIR}  PATH=/x`), false);
  assert.equal(pool(`${CMD} PATH=/usr/bin HOME=/home/other`), false);
  assert.equal(pool(`${CMD} PATH=/usr/bin HOME=${HOME_DIR}2`), false);
  assert.equal(pool(`${CMD} PATH=/usr/bin HOME=${HOME_DIR}/sub`), false);
  assert.equal(pool(`${CMD} HOME=${HOME_DIR} OLD=HOME=${HOME_DIR}`), false);
  assert.equal(pool(`${CMD} JAVA_HOME=/opt/java HOME=${HOME_DIR}`), false);
  assert.equal(pool(`${CMD} HOME=${HOME_DIR} HOME=${HOME_DIR}`), false);
  assert.equal(pool(`${CMD} PATH=/usr/bin`), false, 'no HOME');
  assert.equal(provesDefaultPool(`${CMD} HOME=${HOME_DIR}`, CMD, '').ok, false);
  assert.equal(provesDefaultPool(`${CMD} HOME=${HOME_DIR}`, CMD, 'relative').ok, false);
});

test('provesDefaultPool requires a visible environment after the exact command line', () => {
  assert.equal(pool(CMD), false);
  assert.equal(pool(`${CMD} `), false);
  assert.equal(pool(`${CMD} stray HOME=${HOME_DIR}`), false);
  assert.equal(pool(`other command HOME=${HOME_DIR}`), false);
  assert.equal(pool(''), false);
  assert.equal(pool(null), false);
  assert.equal(provesDefaultPool(`${CMD} HOME=${HOME_DIR}`, '', HOME_DIR).ok, false);
});

// ── resolveSupervisorLease ──────────────────────────────────

function leaseStore(files) {
  return {
    listDir: async () => Object.keys(files),
    readJson: async path => {
      const name = path.split('/').pop();
      if (!(name in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return structuredClone(files[name]);
    },
  };
}

const lease = (pid, nonce, start = STARTED_AT_MS / 1000) => ({
  version: 1, pid, processStartSeconds: start, nonce, createdAt: 1,
});

test('resolveSupervisorLease names the session only from the lease the supervisor itself holds', async () => {
  const store = leaseStore({
    // Held by the supervisor (claimSessionLease: own pid + start + nonce).
    [SESSION_A]: lease(4242, 'n1'),
    // Held by a rescuer: not a supervisor lease.
    [SESSION_B]: lease(5151, 'n2'),
    'not-a-session': lease(4242, 'n3'),
  });
  const resolve = (pid, at = STARTED_AT_MS) => resolveSupervisorLease({
    storePath: '/store/claude-hook-sessions.json', pid, startedAtMs: at, ...store,
  });
  assert.deepEqual(await resolve(4242), {
    sessionId: SESSION_A, pid: 4242, processStartSeconds: STARTED_AT_MS / 1000, nonce: 'n1',
  });
  assert.equal((await resolve(4242, STARTED_AT_MS + 1500))?.sessionId, SESSION_A);
  assert.equal(await resolve(4242, STARTED_AT_MS + 60_000), null, 'recycled pid');
  assert.equal(await resolve(9999), null, 'session leased by someone else');
});

test('resolveSupervisorLease fails closed on no nonce, two leases, or an unreadable store', async () => {
  const at = { storePath: '/store/s.json', pid: 4242, startedAtMs: STARTED_AT_MS };
  assert.equal(await resolveSupervisorLease({
    ...at, ...leaseStore({ [SESSION_A]: { version: 1, pid: 4242, processStartSeconds: STARTED_AT_MS / 1000 } }),
  }), null);
  assert.equal(await resolveSupervisorLease({
    ...at, ...leaseStore({ [SESSION_A]: lease(4242, 'n1'), [SESSION_C]: lease(4242, 'n4') }),
  }), null);
  assert.equal(await resolveSupervisorLease({
    ...at,
    listDir: async () => {
      throw new Error('EACCES');
    },
    readJson: async () => ({}),
  }), null);
});

// ── scanExhaustionTail (strict) ─────────────────────────────

const ROOT = '/t';
const PATH_A = `/t/project/${SESSION_A}.jsonl`;
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;

const user = text => ({ type: 'user', message: { role: 'user', content: text } });
const assistant = text => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const fleetError = uuid => ({
  type: 'assistant',
  uuid,
  isApiErrorMessage: true,
  error: 'rate_limit_error',
  apiErrorStatus: 429,
  message: {
    role: 'assistant',
    content: [{
      type: 'text',
      text: 'API Error: Server is temporarily limiting requests (not your usage limit) · All 4 accounts exhausted. Retry in 7200s.',
    }],
  },
});
const usageLimit = uuid => ({
  type: 'assistant',
  uuid,
  isApiErrorMessage: true,
  error: 'rate_limit',
  apiErrorStatus: 429,
  message: {
    role: 'assistant',
    content: [{
      type: 'text',
      text: "You're out of usage credits. Run /usage-credits to keep using Fable 5 or /model to switch models.",
    }],
  },
});
const loginExpired = {
  type: 'assistant',
  isApiErrorMessage: true,
  error: 'authentication_failed',
  message: { role: 'assistant', content: [{ type: 'text', text: 'Login expired · Please run /login' }] },
};
const jsonl = records => `${records.map(record => JSON.stringify(record)).join('\n')}\n`;

// An in-memory filesystem with the seams scanExhaustionTail uses.
function memoryFs(text, { ino = 77, mode = 0o100600, uid = UID, onRead = null, afterRead = null } = {}) {
  const file = { content: Buffer.from(text, 'utf8'), ino, mode, uid };
  const statOf = () => ({
    dev: 1,
    ino: file.ino,
    size: file.content.length,
    mode: file.mode,
    uid: file.uid,
    isFile: () => true,
  });
  let reads = 0;
  const fs = {
    file,
    lstat: async path => {
      if (path !== PATH_A) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return statOf();
    },
    realpath: async path => path,
    open: async () => ({
      stat: async () => statOf(),
      read: async (buffer, offset, length, position) => {
        reads += 1;
        let n = Math.max(0, Math.min(length, file.content.length - position));
        if (onRead) n = onRead({ n, reads });
        file.content.copy(buffer, offset, position, position + n);
        if (afterRead) afterRead(file);
        return { bytesRead: n, buffer };
      },
      close: async () => {},
    }),
  };
  return fs;
}

const scan = fs => scanExhaustionTail({ path: PATH_A, transcriptRoot: ROOT, sessionId: SESSION_A, fs, uid: UID });

test('scanExhaustionTail reports the last unresolved exhaustion event with identity, offset and id', async () => {
  const before = jsonl([user('일 해 줘'), assistant('네')]);
  const fs = memoryFs(`${before}${jsonl([fleetError(EVENT_UUID_A)])}`);
  assert.deepEqual(await scan(fs), {
    state: 'blocked',
    identity: { dev: 1, ino: 77 },
    offset: Buffer.byteLength(before),
    eventId: EVENT_UUID_A,
    kind: 'fleet_exhausted',
  });
  const usage = await scan(memoryFs(jsonl([user('일'), usageLimit(EVENT_UUID_B)])));
  assert.equal(usage.state, 'blocked');
  assert.equal(usage.kind, 'usage_limit');
});

test('scanExhaustionTail is clear when the conversation continued, there is no error, or another kind', async () => {
  for (const records of [
    [user('일'), fleetError(EVENT_UUID_A), user('계속'), assistant('진행')],
    [user('일'), assistant('완료')],
    [user('일'), loginExpired],
    [],
  ]) {
    assert.deepEqual(await scan(memoryFs(records.length ? jsonl(records) : '')), { state: 'clear' });
  }
});

test('scanExhaustionTail tells error A from a later error B', async () => {
  const a = await scan(memoryFs(jsonl([user('일'), fleetError(EVENT_UUID_A)])));
  const b = await scan(memoryFs(jsonl([user('일'), fleetError(EVENT_UUID_A), user('계속'), fleetError(EVENT_UUID_B)])));
  assert.equal(sameExhaustionEvent(a, a), true);
  assert.equal(sameExhaustionEvent(a, b), false);
  assert.equal(sameExhaustionEvent(a, { ...a, identity: { dev: 1, ino: 78 } }), false);
  assert.equal(sameExhaustionEvent(a, { state: 'clear' }), false);
  assert.equal(sameExhaustionEvent(a, null), false);
  assert.equal(sameExhaustionEvent({ state: 'unknown' }, { state: 'unknown' }), false);
});

test('scanExhaustionTail cannot judge a short read, a shrink, a replacement, or a broken tail', async () => {
  const text = jsonl([user('일'), fleetError(EVENT_UUID_A)]);
  const cases = {
    shortRead: memoryFs(text, { onRead: ({ n }) => Math.max(0, n - 1) }),
    shrunk: memoryFs(text, {
      afterRead: file => {
        file.content = file.content.subarray(0, 10);
      },
    }),
    replaced: memoryFs(text, {
      afterRead: file => {
        file.ino = 78;
      },
    }),
    brokenTail: memoryFs(text.slice(0, -10)),
    unparseable: memoryFs(`${jsonl([user('일')])}{not json\n${jsonl([fleetError(EVENT_UUID_A)])}`),
    notPrivate: memoryFs(text, { mode: 0o100644 }),
    otherOwner: memoryFs(text, { uid: UID + 1 }),
  };
  for (const [name, fs] of Object.entries(cases)) {
    assert.equal((await scan(fs)).state, 'unknown', name);
  }
  assert.equal((await scanExhaustionTail({
    path: '/t/project/missing.jsonl', transcriptRoot: ROOT, sessionId: SESSION_A, fs: memoryFs(text), uid: UID,
  })).state, 'unknown');
  assert.equal((await scanExhaustionTail({
    path: PATH_A, transcriptRoot: '/elsewhere', sessionId: SESSION_A, fs: memoryFs(text), uid: UID,
  })).state, 'unknown', 'outside the transcript root');
  assert.equal((await scanExhaustionTail({
    path: PATH_A, transcriptRoot: ROOT, sessionId: SESSION_B, fs: memoryFs(text), uid: UID,
  })).state, 'unknown', 'file name is not the session');
});
