// Content scan for the cloud-handoff snapshot push.
//
// Fail closed: the scan reads the exact blob bytes `git push` would send —
// every blob reachable from the snapshot commit that the remote does not
// verifiably have — and aborts on any secret hit, any blob it cannot fully
// read as UTF-8 text, or an oversized payload. Detection is pattern-based:
// a secret in an unknown plain-text format can still pass. "Verifiably has" means a tip advertised by
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
// `remote` is the exact URL the caller will push to (default: origin), so
// what counts as "already there" is measured on the push destination itself.
export async function verifiedRemoteBases({ root, runGit, gitEnv, remote = 'origin' }) {
  const upstream = await upstreamMergeRef(root, runGit, gitEnv);
  const wanted = new Set(['HEAD', ...(upstream ? [upstream] : [])]);
  const listed = await git(runGit, root, gitEnv, ['ls-remote', '--', remote, ...wanted], { timeoutMs: 60_000 });
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

// Parses `git cat-file --batch` output for exactly the requested objects
// (each of the type the batch check reported).
function parseBatch(buffer, objectIds, types) {
  const blobs = [];
  let offset = 0;
  for (const [index, objectId] of objectIds.entries()) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) return null;
    const [id, type, sizeText] = buffer.subarray(offset, newline).toString('latin1').split(' ');
    const size = Number(sizeText);
    if (id !== objectId || type !== types[index] || !Number.isSafeInteger(size)) return null;
    const end = newline + 1 + size;
    if (end > buffer.length) return null;
    blobs.push(buffer.subarray(newline + 1, end));
    offset = end + 1;
  }
  return blobs;
}

// Only text the scanner fully read and classified may be pushed: at most
// 1 MiB, no NUL byte, valid UTF-8. Anything else stays local (working-tree
// files) or aborts the push (blobs already in unpushed commits).
export const SNAPSHOT_TEXT_MAX_BYTES = 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function decodeScannableText(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > SNAPSHOT_TEXT_MAX_BYTES || buffer.includes(0)) {
    return null;
  }
  try {
    return UTF8.decode(buffer);
  } catch {
    return null;
  }
}

// Invisible characters that would split a token without changing what a
// reader of the pushed file recovers.
const INVISIBLE_RE = /[\u200b-\u200d\u2060\ufeff]/g;
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

function codePoint(hex) {
  const value = parseInt(hex, 16);
  return value <= 0x10ffff ? String.fromCodePoint(value) : '';
}

// Undoes the cheap encodings that would let a secret pass the patterns:
// backslash-newline continuations, \xHH, \uHHHH, \u{H…}, and %HH.
function decodeEscapes(text) {
  return text
    .replace(/\\\n/g, '')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => codePoint(hex))
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, hex) => codePoint(hex))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => codePoint(hex))
    .replace(/%([0-9a-fA-F]{2})/g, (_, hex) => codePoint(hex));
}

// The views the patterns run over: the text as pushed (line endings and
// invisible characters normalized) and, when different, its decoded copy.
export function scanViews(text) {
  const plain = text.replace(INVISIBLE_RE, '').replace(/\r\n?/g, '\n').replace(CONTROL_RE, '\n');
  const views = [plain];
  let decoded = plain;
  for (let pass = 0; pass < 2; pass += 1) {
    const next = decodeEscapes(decoded).replace(INVISIBLE_RE, '');
    if (next === decoded) break;
    decoded = next;
    views.push(decoded);
  }
  return views;
}

export function textHasSecret(text) {
  return scanViews(text).some(containsSecret);
}

// Tree objects carry file names; names travel too, so they are scanned as
// text (one per line). Entries: "<mode> <name>\0<raw object id>".
export function treeEntryNames(buffer, idBytes) {
  const names = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 1 + idBytes > buffer.length) return null;
    names.push(buffer.subarray(space + 1, nul));
    offset = nul + 1 + idBytes;
  }
  return Buffer.concat(names.flatMap(name => [name, Buffer.from('\n')]));
}

const ARMOR_BEGIN_RE = /^-----BEGIN (PGP|SSH) SIGNATURE-----$/;
const BASE64_LINE_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const PGP_CHECKSUM_RE = /^=[A-Za-z0-9+/]{4}$/;

// The base64 lines of an armored signature are public data, but long opaque
// base64 looks like a token to the scanner. Only a block whose decoded body
// is structurally a signature (an OpenPGP packet, or an "SSHSIG" blob) has
// its base64 lines dropped; armor headers and everything else stay scanned.
function signatureBodyLines(lines) {
  const begin = lines[0]?.match(ARMOR_BEGIN_RE);
  if (!begin || lines[lines.length - 1] !== `-----END ${begin[1]} SIGNATURE-----`) return null;
  const inner = lines.slice(1, -1);
  const body = inner.filter(line => BASE64_LINE_RE.test(line) || PGP_CHECKSUM_RE.test(line));
  const data = Buffer.from(body.filter(line => !PGP_CHECKSUM_RE.test(line)).join(''), 'base64');
  const isSignature = begin[1] === 'SSH'
    ? data.subarray(0, 6).toString('latin1') === 'SSHSIG'
    : data.length > 0 && (data[0] & 0x80) !== 0;
  return isSignature ? new Set(body) : null;
}

// Commit/tag text with verified signature payloads removed.
export function withoutSignaturePayloads(text, type) {
  const lines = text.split('\n');
  const out = [];
  if (type === 'commit') {
    let inHeaders = true;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (inHeaders && line === '') inHeaders = false;
      const sig = inHeaders && line.match(/^(gpgsig(?:-sha256)?) (.*)$/);
      if (!sig) {
        out.push(line);
        continue;
      }
      const block = [sig[2]];
      while (i + 1 < lines.length && lines[i + 1].startsWith(' ')) block.push(lines[(i += 1)].slice(1));
      const drop = signatureBodyLines(block);
      out.push(`${sig[1]} ${block[0]}`, ...block.slice(1).filter(line => !drop?.has(line)).map(line => ` ${line}`));
    }
    return out.join('\n');
  }
  // tag: an armored signature may close the message.
  const start = lines.findIndex(line => ARMOR_BEGIN_RE.test(line));
  if (start === -1) return text;
  const end = lines.findIndex((line, index) => index > start && /^-----END (PGP|SSH) SIGNATURE-----$/.test(line));
  if (end === -1) return text;
  const drop = signatureBodyLines(lines.slice(start, end + 1));
  if (!drop) return text;
  return [...lines.slice(0, start + 1), ...lines.slice(start + 1, end).filter(line => !drop.has(line)), ...lines.slice(end)].join('\n');
}

export async function scanSnapshotForSecrets({ root, commit, runGit, gitEnv: callerEnv = process.env, remote = 'origin' }) {
  // `git replace` would make rev-list/cat-file read substitutes while push
  // sends the originals; scan what is actually stored.
  const gitEnv = { ...callerEnv, GIT_NO_REPLACE_OBJECTS: '1' };
  const failed = { ok: false, reason: 'snapshot-scan-failed' };
  const unscannable = { ok: false, reason: 'snapshot-unscannable' };
  const bases = await verifiedRemoteBases({ root, runGit, gitEnv, remote });
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
  // File contents AND commit objects (author lines, message) travel, so
  // both are scanned; trees carry only names and modes.
  const blobIds = [];
  const blobTypes = [];
  let totalBytes = 0;
  for (const line of checked.stdout.split('\n').filter(Boolean)) {
    const [id, type, sizeText] = line.split(' ');
    if (!OBJECT_ID_RE.test(id || '')) return failed;
    if (type !== 'blob' && type !== 'commit' && type !== 'tag' && type !== 'tree') continue;
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size)) return failed;
    if (size > SNAPSHOT_TEXT_MAX_BYTES) return unscannable;
    blobIds.push(id);
    blobTypes.push(type);
    totalBytes += size;
  }
  if (blobIds.length === 0) return { ok: true };
  if (totalBytes > SNAPSHOT_SCAN_MAX_BYTES) return failed;

  const batch = await git(runGit, root, gitEnv, ['cat-file', '--batch'], {
    input: `${blobIds.join('\n')}\n`,
    timeoutMs: 300_000,
    maxOutputBytes: totalBytes + blobIds.length * 160,
  });
  const blobs = batch.status === 0 && Buffer.isBuffer(batch.stdoutBuffer)
    ? parseBatch(batch.stdoutBuffer, blobIds, blobTypes)
    : null;
  if (!blobs) return failed;
  // SHA-1 ids are 20 raw bytes in a tree, SHA-256 ids 32.
  const idBytes = blobIds[0].length === 64 ? 32 : 20;
  const contents = blobs.map((buffer, index) => (blobTypes[index] === 'tree'
    ? treeEntryNames(buffer, idBytes)
    : buffer));
  if (contents.some(content => content === null)) return unscannable;
  const texts = contents.map(decodeScannableText);
  if (texts.some(text => text === null)) return unscannable;
  for (const [index, type] of blobTypes.entries()) {
    if (type === 'commit' || type === 'tag') texts[index] = withoutSignaturePayloads(texts[index], type);
  }
  return texts.some(textHasSecret) ? { ok: false, reason: 'snapshot-secret' } : { ok: true };
}
