// Secret-shaped fixtures assembled at runtime, so the test sources never hold
// a contiguous secret-shaped literal (secret scanners and review engines
// refuse to ship those). Values are deterministic.

const range = (start, count) => Array.from({ length: count }, (_, i) => String.fromCharCode(start + i));

export const ALNUM = [...range(65, 26), ...range(97, 26), ...range(48, 10)].join('');

// Deterministic letters-and-digits token; always ends in a digit.
export function seededToken(length, seed) {
  let state = (seed >>> 0) || 1;
  let out = '';
  for (let i = 0; i < length - 1; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out += ALNUM[(state >>> 16) % ALNUM.length];
  }
  return `${out}${seed % 10}`;
}

export const assign = (name, value) => [name, value].join('=');

export const JWT = [
  'ey', 'JhbGciOiJIUzI1NiJ9', '.',
  'ey', 'JzdWIiOiIxMjM0NTY3ODkwIn0', '.',
  'dBjftJeZ4CVPmB92K27u', 'hbUJU1p1r_wW1gFWFOEjXk',
].join('');

export const pemHeader = kind => ['-----BEGIN ', kind, ' PRIVATE', ' KEY-----'].join('');
export const pemFooter = kind => ['-----END ', kind, ' PRIVATE', ' KEY-----'].join('');

export const OPAQUE = seededToken(64, 7);
export const GIT_SHA = '0123456789abcdef'.repeat(3).slice(0, 40);
