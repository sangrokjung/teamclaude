// Strict transcript-tail scan for the legacy cloud sidecar.
//
// The sidecar may only stop a waiting supervisor while its session transcript
// still ENDS in the very quota error (fleet exhaustion / usage limit) that the
// supervisor is waiting out. Unlike the rescuer's tolerant scan
// (cmux-session-guards.js, left unchanged), any doubt here is "unknown":
// a short read, a file that shrank, grew or was replaced while being read, an
// unparseable record, or an incomplete last record. Unknown never hands off.

import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, sep } from 'node:path';
import { classifyClaudeApiErrorRecord } from './claude-recovery.js';

export const SIDECAR_TAIL_WINDOW_BYTES = 256 * 1024;
const EXHAUSTION_KINDS = new Set(['fleet_exhausted', 'usage_limit']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NEWLINE = 10;

const realFs = {
  lstat,
  realpath,
  open: path => open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)),
};

function defaultUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function privateFile(info, uid) {
  return Boolean(info?.isFile?.())
    && (uid == null || info.uid === uid)
    && (info.mode & 0o077) === 0;
}

function sameFile(left, right) {
  return Boolean(left && right) && left.dev === right.dev && left.ino === right.ino;
}

function inside(path, root) {
  const rel = relative(root, path);
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Metadata record kinds observed in Claude Code transcripts (2026-10).
const METADATA_RECORD_TYPES = new Set([
  'attachment', 'system', 'summary', 'ai-title', 'custom-title', 'last-prompt',
  'queue-operation', 'permission-mode', 'mode', 'cost-state', 'atis-latch',
  'api-request', 'api-request-blob', 'api-request-shape', 'pr-link', 'frame-link',
  'agent-name', 'file-history-snapshot', 'file-history-delta',
  'artifact-autoreact-ledger', 'artifact-comment-monitor', 'progress',
]);

function isConversationRecord(record) {
  return record?.type === 'user'
    || (record?.type === 'assistant' && record.isApiErrorMessage !== true);
}

// Exactly `length` bytes at `position`, or null on a short read.
async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  if (length === 0) return buffer;
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return bytesRead === length ? buffer : null;
}

// Returns one of:
//   { state: 'blocked', identity: { dev, ino }, offset, eventId, kind }
//     — the last unresolved exhaustion error and where it starts;
//   { state: 'clear' } — no unresolved exhaustion error at the end;
//   { state: 'unknown', reason } — cannot be judged (never hand off).
export async function scanExhaustionTail({
  path,
  transcriptRoot,
  sessionId,
  fs = realFs,
  uid = defaultUid(),
  windowBytes = SIDECAR_TAIL_WINDOW_BYTES,
}) {
  const unknown = reason => ({ state: 'unknown', reason });
  if (typeof path !== 'string' || typeof transcriptRoot !== 'string'
      || !UUID_RE.test(sessionId || '')) {
    return unknown('invalid input');
  }
  try {
    const before = await fs.lstat(path);
    if (!privateFile(before, uid)) return unknown('not a private regular file');
    const [resolved, root] = await Promise.all([fs.realpath(path), fs.realpath(transcriptRoot)]);
    if (!inside(resolved, root) || basename(resolved) !== `${sessionId}.jsonl`) {
      return unknown('not this session transcript');
    }
    const handle = await fs.open(resolved);
    try {
      const info = await handle.stat();
      if (!privateFile(info, uid) || !sameFile(info, before)) return unknown('identity changed');
      const size = info.size;

      // Window start; when it cuts a record, look back one more window for
      // that record's start (an error record is small).
      let start = Math.max(0, size - windowBytes);
      let boundary = start === 0;
      if (start > 0) {
        const from = Math.max(0, start - windowBytes);
        const probe = await readExactly(handle, start - from, from);
        if (!probe) return unknown('short read');
        const newline = probe.lastIndexOf(NEWLINE);
        if (newline !== -1) {
          start = from + newline + 1;
          boundary = true;
        } else if (from === 0) {
          start = 0;
          boundary = true;
        }
      }
      const buffer = await readExactly(handle, size - start, start);
      if (!buffer) return unknown('short read');

      // Nothing may have changed while reading.
      const [after, again] = await Promise.all([handle.stat(), fs.lstat(path)]);
      if (!sameFile(after, info) || after.size !== size || !sameFile(again, info)
          || again.size !== size) {
        return unknown('changed while reading');
      }
      if (buffer.length > 0 && buffer[buffer.length - 1] !== NEWLINE) {
        return unknown('incomplete last record');
      }

      let blocked = null;
      let position = 0;
      let first = true;
      while (position < buffer.length) {
        const end = buffer.indexOf(NEWLINE, position);
        const line = buffer.subarray(position, end);
        const offset = start + position;
        position = end + 1;
        const cut = first && !boundary;
        first = false;
        // A record longer than the look-back window is a conversation record
        // (it would resolve any earlier error), and nothing earlier is visible.
        if (cut) {
          blocked = null;
          continue;
        }
        if (line.length === 0) continue;
        let record;
        try {
          record = JSON.parse(line.toString('utf8'));
        } catch {
          return unknown('unparseable record');
        }
        if (record === null || typeof record !== 'object' || Array.isArray(record)) {
          return unknown('non-object record');
        }
        // Every transcript record carries a `type` discriminator. Only turns
        // and the known metadata types (which neither resolve nor raise an
        // error) are understood; anything else — a new Claude Code record
        // kind included — makes the tail unjudgeable, so no handoff.
        if (record.type !== 'user' && record.type !== 'assistant'
            && !METADATA_RECORD_TYPES.has(record.type)) {
          return unknown('unrecognized record type');
        }
        if ((record.type === 'user' || record.type === 'assistant')
            && (record.message === null || typeof record.message !== 'object'
              || Array.isArray(record.message))) {
          return unknown('turn without a message');
        }
        const event = classifyClaudeApiErrorRecord(record);
        if (event && EXHAUSTION_KINDS.has(event.kind)) {
          blocked = {
            offset,
            eventId: typeof record.uuid === 'string' && UUID_RE.test(record.uuid)
              ? record.uuid.toLowerCase()
              : null,
            kind: event.kind,
          };
        } else if (blocked && (event || record.isApiErrorMessage === true
            || isConversationRecord(record))) {
          // Any later API error (login, ambiguous dispatch, ...) or turn
          // supersedes the exhaustion: it is no longer the last word.
          blocked = null;
        }
      }
      if (!blocked) return { state: 'clear' };
      return {
        state: 'blocked',
        identity: { dev: info.dev, ino: info.ino },
        offset: blocked.offset,
        eventId: blocked.eventId,
        kind: blocked.kind,
      };
    } finally {
      await handle.close();
    }
  } catch {
    return unknown('unreadable');
  }
}

// The same error event (same file identity, same record offset and id) is
// still the last unresolved word.
export function sameExhaustionEvent(first, current) {
  return first?.state === 'blocked'
    && current?.state === 'blocked'
    && sameFile(first.identity, current.identity)
    && first.offset === current.offset
    && first.eventId === current.eventId
    && first.kind === current.kind;
}
