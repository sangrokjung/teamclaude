import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseFramer, sseErrorEvent, isEventStream } from '../src/sse.js';

const b = s => Buffer.from(s, 'utf8');

test('forwards only whole SSE events, holding back the partial frame', () => {
  const f = new SseFramer();
  assert.equal(f.push(b('event: message_start\ndata: {"a"')), null);
  const out = f.push(b(':1}\n\nevent: content_block_delta\ndata: {"b'));
  assert.equal(out.toString(), 'event: message_start\ndata: {"a":1}\n\n');
  assert.equal(f.pending.toString(), 'event: content_block_delta\ndata: {"b');
  const out2 = f.push(b('":2}\n\n'));
  assert.equal(out2.toString(), 'event: content_block_delta\ndata: {"b":2}\n\n');
  assert.equal(f.pending.length, 0);
  assert.equal(f.sawTerminal, false);
});

test('reassembled stream is byte-identical at any chunking', () => {
  const full = 'event: message_start\ndata: {"x":1}\n\n'
    + 'event: content_block_delta\ndata: {"t":"hi"}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  for (const size of [1, 2, 3, 7, 64]) {
    const f = new SseFramer();
    const outs = [];
    for (let i = 0; i < full.length; i += size) {
      const out = f.push(b(full.slice(i, i + size)));
      if (out) outs.push(out);
    }
    outs.push(f.pending);
    assert.equal(Buffer.concat(outs).toString(), full, `chunk size ${size}`);
    assert.equal(f.sawTerminal, true, `terminal missed at chunk size ${size}`);
  }
});

test('multibyte UTF-8 split across chunks stays byte-identical', () => {
  const buf = b('event: content_block_delta\ndata: {"t":"한국어 스트림 데이터"}\n\n');
  const f = new SseFramer();
  const outs = [];
  for (let i = 0; i < buf.length; i += 5) {
    const out = f.push(buf.subarray(i, Math.min(i + 5, buf.length)));
    if (out) outs.push(out);
  }
  outs.push(f.pending);
  assert.deepEqual(Buffer.concat(outs), buf);
});

test('terminal detection: event name, error, data-only JSON, [DONE], CRLF', () => {
  let f = new SseFramer();
  f.push(b('event: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n'));
  assert.equal(f.sawTerminal, true, 'error event');

  f = new SseFramer();
  f.push(b('data: {"type":"response.completed","response":{}}\n\n'));
  assert.equal(f.sawTerminal, true, 'data-only response.completed');

  f = new SseFramer();
  f.push(b('data: [DONE]\n\n'));
  assert.equal(f.sawTerminal, true, '[DONE] marker');

  f = new SseFramer();
  f.push(b('event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n'));
  assert.equal(f.sawTerminal, true, 'CRLF framing');

  f = new SseFramer();
  f.push(b('event: content_block_delta\ndata: {"t":"message_stop mentioned in content"}\n\n'));
  assert.equal(f.sawTerminal, false, 'content mentioning message_stop must not count');

  f = new SseFramer();
  f.push(b('event: ping\ndata: {"type":"ping"}\n\n'));
  assert.equal(f.sawTerminal, false, 'ping is not terminal');

  // SSE spec: a repeated `event:` field is overwritten — the LAST one wins.
  f = new SseFramer();
  f.push(b('event: message_stop\nevent: ping\ndata: {"type":"ping"}\n\n'));
  assert.equal(f.sawTerminal, false, 'last event field wins (ping)');
  f.push(b('event: ping\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'));
  assert.equal(f.sawTerminal, true, 'last event field wins (message_stop)');

  // SSE spec: multiple `data:` lines concatenate with newlines.
  f = new SseFramer();
  f.push(b('data: {"type":\ndata: "response.completed"}\n\n'));
  assert.equal(f.sawTerminal, true, 'multi-line data terminal joined before parse');
});

test('accepts plain Uint8Array chunks (web-stream readers yield those, not Buffers)', () => {
  const f = new SseFramer();
  const bytes = new TextEncoder().encode('event: message_start\ndata: {"a":1}\n\npartial');
  const out = f.push(new Uint8Array(bytes));
  assert.equal(out.toString(), 'event: message_start\ndata: {"a":1}\n\n');
  assert.equal(f.pending.toString(), 'partial');
});

test('oversized frame degrades to passthrough, keeps flowing, still spots the terminal', () => {
  const f = new SseFramer({ maxBufferedBytes: 1024 });
  const big = 'data: {"t":"' + 'x'.repeat(2048);
  const out = f.push(b(big));
  assert.equal(f.passthrough, true);
  assert.equal(out.toString(), big);
  const rest = 'y"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  assert.equal(f.push(b(rest)).toString(), rest);
  assert.equal(f.sawTerminal, true);
});

test('retained frame bytes reserve and release their exact lifetime', () => {
  let reserved = 0;
  const f = new SseFramer({
    reserveBytes: bytes => { reserved += bytes; return true; },
    releaseBytes: bytes => { reserved -= bytes; },
  });
  assert.equal(f.push(b('event: ping\ndata: partial')), null);
  assert.equal(reserved, b('event: ping\ndata: partial').length);
  const out = f.push(b('\n\n'));
  assert.equal(reserved, out.length);
  f.releaseForwarded(out.length);
  assert.equal(reserved, 0);
  f.dispose();
  assert.equal(reserved, 0);
});

test('a first partial frame needs only one aggregate reservation', () => {
  const partial = b('event: ping\ndata: partial');
  let reserved = 0;
  const f = new SseFramer({
    reserveBytes: bytes => {
      if (reserved + bytes > partial.length) return false;
      reserved += bytes;
      return true;
    },
    releaseBytes: bytes => { reserved -= bytes; },
  });
  assert.equal(f.push(partial), null);
  assert.equal(f.limitExceeded, false);
  assert.equal(reserved, partial.length);
  f.dispose();
  assert.equal(reserved, 0);
});

test('concatenating a partial frame reserves the destination peak', () => {
  const first = b('event: ping\ndata: par');
  const second = b('tial\n\n');
  const combinedBytes = first.length + second.length;
  let reserved = 0;
  let peak = 0;
  const f = new SseFramer({
    reserveBytes: bytes => {
      reserved += bytes;
      peak = Math.max(peak, reserved);
      return true;
    },
    releaseBytes: bytes => { reserved -= bytes; },
  });
  assert.equal(f.push(first), null);
  const out = f.push(second);
  assert.equal(out.toString(), Buffer.concat([first, second]).toString());
  assert.equal(peak, combinedBytes * 2);
  assert.equal(reserved, combinedBytes);
  f.releaseForwarded(out.length);
  assert.equal(reserved, 0);
});

test('a failed concatenation peak keeps only the original partial frame reserved', () => {
  const first = b('event: ping\ndata: par');
  const second = b('tial\n\n');
  const maxBytes = (first.length + second.length) * 2 - 1;
  let reserved = 0;
  const f = new SseFramer({
    reserveBytes: bytes => {
      if (reserved + bytes > maxBytes) return false;
      reserved += bytes;
      return true;
    },
    releaseBytes: bytes => { reserved -= bytes; },
  });
  assert.equal(f.push(first), null);
  assert.equal(f.push(second), null);
  assert.equal(f.limitExceeded, true);
  assert.equal(f.pending.toString(), first.toString());
  assert.equal(reserved, first.length);
  f.dispose();
  assert.equal(reserved, 0);
});

test('splitting a complete frame reserves the copied remainder peak', () => {
  const frame = b('event: ping\ndata: ok\n\n');
  const remainder = b('event: next\ndata: partial');
  const input = Buffer.concat([frame, remainder]);
  let reserved = 0;
  let peak = 0;
  const f = new SseFramer({
    reserveBytes: bytes => {
      reserved += bytes;
      peak = Math.max(peak, reserved);
      return true;
    },
    releaseBytes: bytes => { reserved -= bytes; },
  });
  const out = f.push(input);
  assert.equal(out.toString(), frame.toString());
  assert.equal(peak, input.length + remainder.length);
  f.releaseForwarded(out.length);
  assert.equal(reserved, remainder.length);
  f.dispose();
  assert.equal(reserved, 0);
});

test('a trailing partial frame transfers its reservation to the consumer', () => {
  const frame = b('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  const trailing = b(': trailing-comment');
  let reserved = 0;
  const f = new SseFramer({
    reserveBytes: bytes => { reserved += bytes; return true; },
    releaseBytes: bytes => { reserved -= bytes; },
  });
  const out = f.push(Buffer.concat([frame, trailing]));
  f.releaseForwarded(out.length);
  const tail = f.takePending();
  assert.equal(tail.toString(), trailing.toString());
  f.releaseForwarded(tail.length);
  assert.equal(reserved, 0);
  f.dispose();
});

test('aggregate reservation failure leaves no retained frame bytes', () => {
  let reserved = 0;
  const f = new SseFramer({
    reserveBytes: () => false,
    releaseBytes: bytes => { reserved -= bytes; },
  });
  assert.equal(f.push(b('event: ping\ndata: partial')), null);
  assert.equal(f.limitExceeded, true);
  assert.equal(f.pending.length, 0);
  assert.equal(reserved, 0);
  f.dispose();
});

test('passthrough chunks stay reserved until their consumer releases them', () => {
  let reserved = 0;
  const f = new SseFramer({
    maxBufferedBytes: 4,
    reserveBytes: bytes => { reserved += bytes; return true; },
    releaseBytes: bytes => { reserved -= bytes; },
  });
  const first = f.push(b('oversized'));
  assert.equal(f.passthrough, true);
  assert.equal(reserved, first.length);
  f.releaseForwarded(first.length);
  assert.equal(reserved, 0);
  const second = f.push(b('raw'));
  assert.equal(reserved, second.length);
  f.releaseForwarded(second.length);
  assert.equal(reserved, 0);
  f.dispose();
});

test('sseErrorEvent is a parseable retryable error frame', () => {
  const frame = sseErrorEvent('boom');
  assert.match(frame, /^event: error\ndata: .+\n\n$/s);
  const data = JSON.parse(frame.split('\n')[1].slice('data: '.length));
  assert.deepEqual(data, { type: 'error', error: { type: 'overloaded_error', message: 'boom' } });
});

test('isEventStream matches SSE content types only', () => {
  assert.equal(isEventStream('text/event-stream'), true);
  assert.equal(isEventStream('text/event-stream; charset=utf-8'), true);
  assert.equal(isEventStream('application/json'), false);
  assert.equal(isEventStream(undefined), false);
});
