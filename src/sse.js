// SSE resilience helpers shared by the proxy worker (server.js) and the
// supervisor relay (index.js).
//
// Problem: when the upstream side of an SSE relay dies mid-stream — an upstream
// network blip, or the proxy worker being replaced under the supervisor — the
// client either gets its socket destroyed or a response that ends in the middle
// of an event with no terminal SSE event. Claude Code surfaces both as
// "API Error: Connection closed mid-response. The response above may be
// incomplete." and FAILS the turn: a raw connection loss is not classified as
// retryable, so nothing retries and the session stalls until a human re-prompts.
//
// Fix (two cooperating pieces):
//   1. SseFramer — the relay forwards only WHOLE SSE events (frames). A partial
//      frame stays buffered until its terminating blank line arrives, so an
//      abnormal end never leaves the client's SSE parser holding half a JSON
//      payload. The framer also tracks whether a TERMINAL event (message_stop /
//      error / response.completed / [DONE]) was delivered.
//   2. sseErrorEvent — on an abnormal end (upstream read error, or a clean end
//      with no terminal event = silent truncation) the relay appends this
//      well-formed `event: error` frame with type `overloaded_error` and ends
//      the response cleanly. `overloaded_error` is the error type the Anthropic
//      API itself uses for in-stream capacity failures (the streaming docs call
//      it the in-stream form of HTTP 529), and clients — Claude Code included —
//      auto-retry it with backoff. The dead turn becomes a transparent retry.

// Beyond this many buffered bytes with no frame boundary in sight, framing
// degrades to raw passthrough (memory bound wins over boundary cleanliness).
// Real SSE events are tiny; this only triggers on a pathological upstream.
export const SSE_MAX_FRAME_BYTES = 4 * 1024 * 1024;

const BOUNDARY_LF = Buffer.from('\n\n');
const BOUNDARY_CRLF = Buffer.from('\r\n\r\n');
const EMPTY = Buffer.alloc(0);

// Event types/names that mean the stream completed ON PURPOSE. `message_stop` /
// `error` are the Anthropic Messages terminals; `response.*` / `[DONE]` cover
// OpenAI-style streams (the Codex backend) so terminal tracking stays correct
// even where error injection is not enabled.
const TERMINAL_EVENTS = new Set([
  'message_stop', 'error',
  'response.completed', 'response.failed', 'response.incomplete',
]);
// A data line longer than this is a content delta, never a terminal marker —
// skip the JSON parse for it (terminal events are tiny).
const MAX_TERMINAL_DATA_PARSE = 2048;

export function isEventStream(contentType) {
  return (contentType || '').includes('text/event-stream');
}

/**
 * Build a well-formed, client-retryable SSE error frame. Kept to the exact
 * shape the Anthropic API uses for in-stream errors so client SDK retry
 * classification applies unchanged.
 */
export function sseErrorEvent(message) {
  const payload = JSON.stringify({
    type: 'error',
    error: { type: 'overloaded_error', message },
  });
  return `event: error\ndata: ${payload}\n\n`;
}

/**
 * Incremental SSE frame buffer: feed raw chunks in, get back only bytes that
 * end on an event boundary. Everything returned by push() is a contiguous
 * prefix of the stream (byte-identical relay); the unforwarded remainder is
 * available as `pending`.
 */
export class SseFramer {
  constructor({
    maxBufferedBytes = SSE_MAX_FRAME_BYTES,
    reserveBytes = null,
    releaseBytes = null,
  } = {}) {
    this.maxBufferedBytes = maxBufferedBytes;
    this.reserveBytes = typeof reserveBytes === 'function' ? reserveBytes : null;
    this.releaseBytes = typeof releaseBytes === 'function' ? releaseBytes : null;
    this.pending = EMPTY;
    this.reservedBytes = 0;
    this.forwardedReservationBytes = 0;
    this.limitExceeded = false;
    this.bufferBudgetExceeded = false;
    this.sawTerminal = false;
    // Set when a frame exceeded maxBufferedBytes: framing is abandoned and
    // chunks pass straight through (terminal tracking falls back to a rolling
    // substring scan — see _scanRaw).
    this.passthrough = false;
    this._rawTail = '';
  }

  /**
   * Feed one upstream chunk. Returns the bytes now safe to forward (whole
   * frames only), or null while a partial frame is still accumulating.
   * Accepts Buffer or Uint8Array (web-stream readers yield the latter, whose
   * own lastIndexOf cannot take a byte-sequence needle — normalize first).
   */
  push(input) {
    const chunk = Buffer.isBuffer(input)
      ? input
      : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    if (this.passthrough) {
      if (this.reserveBytes && !this.reserveBytes(chunk.length)) {
        this.limitExceeded = true;
        this.bufferBudgetExceeded = true;
        return null;
      }
      if (this.reserveBytes) this.reservedBytes += chunk.length;
      this.forwardedReservationBytes = chunk.length;
      this._scanRaw(chunk.toString('utf8'));
      return chunk;
    }
    if (this.reserveBytes && !this.reserveBytes(chunk.length)) {
      this.limitExceeded = true;
      this.bufferBudgetExceeded = true;
      return null;
    }
    if (this.reserveBytes) this.reservedBytes += chunk.length;
    if (this.pending.length) {
      const combinedBytes = this.pending.length + chunk.length;
      if (this.reserveBytes && !this.reserveBytes(combinedBytes)) {
        this.releaseBytes?.(chunk.length);
        this.reservedBytes -= chunk.length;
        this.limitExceeded = true;
        this.bufferBudgetExceeded = true;
        return null;
      }
      const previousBytes = this.reservedBytes;
      this.pending = Buffer.concat([this.pending, chunk], combinedBytes);
      if (this.reserveBytes) {
        this.reservedBytes += combinedBytes;
        this.releaseBytes?.(previousBytes);
        this.reservedBytes -= previousBytes;
      }
    } else {
      this.pending = chunk;
    }

    // Find the LAST complete frame boundary; support both LF and CRLF blank
    // lines (Anthropic emits LF; CRLF-only upstreams still frame correctly).
    const lf = this.pending.lastIndexOf(BOUNDARY_LF);
    const crlf = this.pending.lastIndexOf(BOUNDARY_CRLF);
    let end = -1;
    if (lf !== -1) end = lf + BOUNDARY_LF.length;
    if (crlf !== -1) end = Math.max(end, crlf + BOUNDARY_CRLF.length);

    if (end === -1) {
      if (this.pending.length > this.maxBufferedBytes) {
        // Pathologically large frame: stop framing, flush raw. An abnormal end
        // after this point may land mid-event — the memory bound wins.
        this.passthrough = true;
        const out = this.pending;
        this.pending = EMPTY;
        this.forwardedReservationBytes = out.length;
        this._scanRaw(out.toString('utf8'));
        return out;
      }
      return null;
    }

    const out = this.pending.subarray(0, end);
    const parentBytes = this.pending.length;
    const remainderBytes = parentBytes - end;
    if (remainderBytes > 0) {
      if (this.reserveBytes && !this.reserveBytes(remainderBytes)) {
        this.releaseBytes?.(this.reservedBytes);
        this.reservedBytes = 0;
        this.pending = EMPTY;
        this.limitExceeded = true;
        this.bufferBudgetExceeded = true;
        return null;
      }
      this.pending = Buffer.from(this.pending.subarray(end));
      if (this.reserveBytes) this.reservedBytes += remainderBytes;
    } else {
      this.pending = EMPTY;
    }
    this.forwardedReservationBytes = parentBytes;
    this._scanFrames(out.toString('utf8'));
    return out;
  }

  releaseForwarded(bytes, releaseBudget = true) {
    if (!this.reserveBytes || bytes <= 0) return;
    if (bytes > this.forwardedReservationBytes
        || this.forwardedReservationBytes > this.reservedBytes) {
      throw new Error('SSE frame reservation underflow');
    }
    if (releaseBudget) this.releaseBytes?.(this.forwardedReservationBytes);
    this.reservedBytes -= this.forwardedReservationBytes;
    this.forwardedReservationBytes = 0;
  }

  takePending() {
    const out = this.pending;
    this.pending = EMPTY;
    this.forwardedReservationBytes = out.length;
    return out;
  }

  dispose() {
    if (this.reserveBytes && this.reservedBytes > 0) {
      this.releaseBytes?.(this.reservedBytes);
      this.reservedBytes = 0;
    }
    this.pending = EMPTY;
    this.forwardedReservationBytes = 0;
  }

  // Frame boundaries are ASCII, so flushed bytes never split a UTF-8 character
  // and per-flush toString() is lossless here.
  _scanFrames(text) {
    if (this.sawTerminal) return;
    for (const block of text.split(/\r?\n\r?\n/)) {
      if (!block) continue;
      // Per the SSE spec, a repeated `event:` field is overwritten — the LAST
      // one wins — and multiple `data:` lines concatenate with newlines.
      const eventLines = [...block.matchAll(/^event:[ \t]?(.*)$/gm)];
      if (eventLines.length) {
        if (TERMINAL_EVENTS.has(eventLines[eventLines.length - 1][1].trim())) {
          this.sawTerminal = true;
        }
        continue;
      }
      const dataLines = [...block.matchAll(/^data:[ \t]?(.*)$/gm)].map(m => m[1]);
      if (!dataLines.length) continue;
      const data = dataLines.join('\n').trim();
      if (data === '[DONE]') { this.sawTerminal = true; continue; }
      if (data.length > MAX_TERMINAL_DATA_PARSE || !data.startsWith('{')) continue;
      try {
        if (TERMINAL_EVENTS.has(JSON.parse(data)?.type)) this.sawTerminal = true;
      } catch { /* not JSON — not a terminal marker */ }
    }
  }

  // Passthrough-mode terminal scan: a data line can never contain a raw
  // newline (JSON strings escape them), so `\nevent: <terminal>` as raw bytes
  // is unambiguous. A small tail carries over so a marker split across chunks
  // is still seen.
  _scanRaw(text) {
    if (this.sawTerminal) return;
    const hay = this._rawTail + text;
    if (/\r?\n\r?\nevent:[ \t]?(message_stop|error|response\.(completed|failed|incomplete))[ \t]*\r?\n/.test(hay)
      || /\r?\ndata:[ \t]?\[DONE\]/.test(hay)) {
      this.sawTerminal = true;
    }
    this._rawTail = hay.slice(-64);
  }
}
