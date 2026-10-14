// Content scan for the cloud-handoff snapshot push.
//
// Fail closed: the scan reads the exact blob bytes `git push` would send —
// every blob reachable from the snapshot commit that the remote does not
// verifiably have — and aborts on any secret hit, unreadable object, or
// oversized payload. "Verifiably has" means a tip advertised by
// `git ls-remote origin` right now, never a local (movable) remote-tracking
// ref. Without such a tip, everything reachable is scanned.

import { containsSecret } from './secrets.js';

export const SNAPSHOT_SCAN_MAX_BYTES = 256 * 1024 * 1024;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function git(runGit, root, gitEnv, args, options = {}) {
  return runGit(args, { cwd: root, env: gitEnv, ...options });
}

async function upstreamMergeRef(root, runGit, gitEnv) {
  const head = await git(runGit, root, gitEnv, ['symbolic-ref', '--quiet', 'HEAD']);
  const ref = head.status === 0 ? head.stdout.trim() : '';
  if (!ref.startsWith('refs/heads/')) return null;
  const branch = ref.slice('refs/heads/'.length);
  const remote = await git(runGit, root, gitEnv, ['config', '--get', `branch.${branch}.remote`]);
  const merge = await git(runGit, root, gitEnv, ['config', '--get', `branch.${branch}.merge`]);
  if (remote.status !== 0 || remote.stdout.trim() !== 'origin' || merge.status !== 0) return null;
  const mergeRef = merge.stdout.trim();
  return mergeRef.startsWith('refs/heads/') ? mergeRef : null;
}

// Tips of the upstream branch and origin's HEAD as the remote advertises
// them now, kept only when the commit exists locally (rev-list needs it).
export async function verifiedRemoteBases({ root, runGit, gitEnv }) {
  const upstream = await upstreamMergeRef(root, runGit, gitEnv);
  const wanted = new Set(['HEAD', ...(upstream ? [upstream] : [])]);
  const listed = await git(runGit, root, gitEnv, ['ls-remote', 'origin', ...wanted], { timeoutMs: 60_000 });
  if (listed.status !== 0) return [];
  const bases = [];
  for (const line of listed.stdout.split('\n')) {
    const [objectId, refName] = line.split('\t');
    if (!OBJECT_ID_RE.test(objectId || '') || !wanted.has(refName) || bases.includes(objectId)) continue;
    const exists = await git(runGit, root, gitEnv, ['cat-file', '-e', `${objectId}^{commit}`]);
    if (exists.status === 0) bases.push(objectId);
  }
  return bases;
}

// Parses `git cat-file --batch` output for exactly the requested blobs.
function parseBatch(buffer, objectIds) {
  const blobs = [];
  let offset = 0;
  for (const objectId of objectIds) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) return null;
    const [id, type, sizeText] = buffer.subarray(offset, newline).toString('latin1').split(' ');
    const size = Number(sizeText);
    if (id !== objectId || type !== 'blob' || !Number.isSafeInteger(size)) return null;
    const end = newline + 1 + size;
    if (end > buffer.length) return null;
    blobs.push(buffer.subarray(newline + 1, end));
    offset = end + 1;
  }
  return blobs;
}

// Invisible characters that would split a token without changing what a
// reader of the pushed file recovers.
const INVISIBLE_RE = /[​-‍⁠﻿]/g;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function normalizeText(text) {
  return text.replace(INVISIBLE_RE, '').replace(/\r\n?/g, '\n').replace(CONTROL_RE, '\n');
}

// Every reading of a blob a consumer could reasonably make: plain UTF-8 for
// text; for NUL-carrying content, its printable runs as single-byte text and
// as UTF-16 (LE and BE), so a NUL byte cannot hide a secret.
export function blobTextViews(buffer) {
  if (!buffer.includes(0)) return [normalizeText(buffer.toString('utf8'))];
  const even = buffer.subarray(0, buffer.length - (buffer.length % 2));
  const swapped = Buffer.from(even).swap16();
  return [
    normalizeText(buffer.toString('latin1')),
    normalizeText(even.toString('utf16le')),
    normalizeText(swapped.toString('utf16le')),
  ];
}

export async function scanSnapshotForSecrets({ root, commit, runGit, gitEnv = process.env }) {
  const failed = { ok: false, reason: 'snapshot-scan-failed' };
  const bases = await verifiedRemoteBases({ root, runGit, gitEnv });
  const revList = ['rev-list', '--objects', '--no-object-names', commit];
  if (bases.length > 0) revList.push('--not', ...bases);
  const listed = await git(runGit, root, gitEnv, revList, { timeoutMs: 120_000 });
  if (listed.status !== 0) return failed;
  const objectIds = listed.stdout.split('\n').map(line => line.trim()).filter(Boolean);
  if (objectIds.some(id => !OBJECT_ID_RE.test(id))) return failed;
  if (objectIds.length === 0) return { ok: true };

  const checked = await git(
    runGit,
    root,
    gitEnv,
    ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    { input: `${objectIds.join('\n')}\n`, timeoutMs: 120_000 },
  );
  if (checked.status !== 0) return failed;
  const blobIds = [];
  let totalBytes = 0;
  for (const line of checked.stdout.split('\n').filter(Boolean)) {
    const [id, type, sizeText] = line.split(' ');
    if (!OBJECT_ID_RE.test(id || '')) return failed;
    if (type !== 'blob') continue;
    blobIds.push(id);
    totalBytes += Number(sizeText) || 0;
  }
  if (blobIds.length === 0) return { ok: true };
  if (totalBytes > SNAPSHOT_SCAN_MAX_BYTES) return failed;

  const batch = await git(runGit, root, gitEnv, ['cat-file', '--batch'], {
    input: `${blobIds.join('\n')}\n`,
    timeoutMs: 300_000,
    maxOutputBytes: totalBytes + blobIds.length * 160,
  });
  const blobs = batch.status === 0 && Buffer.isBuffer(batch.stdoutBuffer)
    ? parseBatch(batch.stdoutBuffer, blobIds)
    : null;
  if (!blobs) return failed;
  const leaked = blobs.some(blob => blobTextViews(blob).some(containsSecret));
  return leaked ? { ok: false, reason: 'snapshot-secret' } : { ok: true };
}
