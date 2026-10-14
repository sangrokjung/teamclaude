// Secret detection shared by the Codex file handoff, the cloud-session prompt,
// and the cloud snapshot content scan.
//
// redactSecrets() is deliberately aggressive: it rewrites prompt text that is
// only ever read by a model, so a false positive costs a few characters.
// containsSecret() gates a `git push` of source files, so it reuses the same
// pattern rules (a hit = "redaction would change the text") but swaps the
// loose `name: value` rules for a stricter assignment check; otherwise every
// `const token = await refresh()` in ordinary code would block the snapshot.

const PEM_BLOCK_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_HEADER_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/;
// Token patterns start only at the beginning of a token run (lookbehind, not
// \b) so a megabyte of `sk-sk-…` or `a-a-…` stays linear instead of
// re-scanning the run from every boundary.
const SK_TOKEN_RE = /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{12,}/g;
const PROVIDER_TOKEN_RE = /(?<![A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|npm_[A-Za-z0-9]{20,}|pypi-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}\b)/g;
const JWT_RE = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER_RE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const JSON_TOKEN_RE = /("(?:access|refresh|api)[_-]?token"\s*:\s*")[^"]+(")/gi;
// Any scheme: "Authorization: Token x", "Digest ...", custom schemes.
const AUTHORIZATION_RE = /\b(authorization)("?[ \t]*[:=][ \t]*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\r\n]*)/gi;
const LOOSE_ASSIGNMENT_RE = /(?<![A-Za-z0-9_-])((?:[A-Za-z0-9]+[_-]){0,16}(?:api[_-]?key|token|secret|password|credential|signature|cookie|authorization)(?:[_-][A-Za-z0-9]+){0,16})\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
// A maximal run of token characters; judged by isOpaqueSecret().
const OPAQUE_RUN_RE = /(?<![A-Za-z0-9_\-+/=])[A-Za-z0-9_\-+/=]{40,}(?![A-Za-z0-9_\-+/=])/g;
const UUID_ANY_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const GIT_SHA1_RE = /^[0-9a-f]{40}$/;
// Subresource-integrity digests (package-lock, yarn.lock) are public.
const SRI_RE = /^sha(?:1|256|384|512)-/i;

function hasLetterAndDigit(value) {
  return /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

// `fix-login-retry-flow-2`-style slugs of short words
// (branch names, spec ids), not a random token.
function isWordSlug(piece) {
  const words = piece.split(/[-_]/);
  return words.length >= 4 && words.every(word => word.length <= 12);
}

function isOpaqueSecret(run) {
  if (GIT_SHA1_RE.test(run) || SRI_RE.test(run)) return false;
  // A path: every slash-separated segment is short.
  if (run.includes('/') && run.split('/').every(segment => segment.length < 40)) return false;
  // UUIDs inside identifiers are not secrets; judge what remains.
  return run
    .replace(UUID_ANY_RE, ' ')
    .split(' ')
    .some(piece => piece.length >= 40 && hasLetterAndDigit(piece) && !isWordSlug(piece));
}

function redactOpaque(text) {
  return text.replace(OPAQUE_RUN_RE, run => (isOpaqueSecret(run) ? '[REDACTED]' : run));
}

// Pattern-only rules shared by the prompt redaction and the content scan.
function redactStrong(text) {
  return redactOpaque(text
    .replace(PEM_BLOCK_RE, '[REDACTED PRIVATE KEY]')
    .replace(SK_TOKEN_RE, '[REDACTED]')
    .replace(PROVIDER_TOKEN_RE, '[REDACTED]')
    .replace(JWT_RE, '[REDACTED JWT]'));
}

export function redactSecrets(text) {
  const contextual = text
    .replace(PEM_BLOCK_RE, '[REDACTED PRIVATE KEY]')
    .replace(BEARER_RE, '$1 [REDACTED]')
    .replace(SK_TOKEN_RE, '[REDACTED]')
    .replace(PROVIDER_TOKEN_RE, '[REDACTED]')
    .replace(JWT_RE, '[REDACTED JWT]')
    .replace(JSON_TOKEN_RE, '$1[REDACTED]$2')
    .replace(AUTHORIZATION_RE, '$1$2[REDACTED]')
    .replace(LOOSE_ASSIGNMENT_RE, '$1$2[REDACTED]');
  return redactOpaque(contextual);
}

const SECRET_WORDS = ['key', 'keys', 'token', 'tokens', 'secret', 'secrets',
  'password', 'passwords', 'passwd', 'credential', 'credentials'];
// `API_KEY_ID`, `secretName`, `token_path`: the value names a secret, it is not one.
const BENIGN_LAST_WORDS = new Set(['id', 'ids', 'name', 'names', 'path', 'file', 'url',
  'type', 'len', 'length', 'count', 'field', 'header', 'prefix', 'label', 'hint', 'env']);

function isSecretName(name) {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0 || BENIGN_LAST_WORDS.has(words[words.length - 1])) return false;
  return words.some(word => SECRET_WORDS.some(secret => word.endsWith(secret)));
}

const PLACEHOLDER_RE = /^(?:(.)\1*|<[^>]*>|\$\{[^}]*\}|\$\([^)]*\)|\{\{[^}]*\}\}|\$[A-Za-z_][A-Za-z0-9_]*)$|changeme|change[_-]me|example|placeholder|dummy|redacted|replace[_-]?me|your[_-]/i;

function isPlausibleSecretValue(value) {
  return typeof value === 'string'
    && value.length >= 16
    && /[A-Za-z0-9]/.test(value)
    && !/\s/.test(value)
    && !PLACEHOLDER_RE.test(value);
}

// `obj.prop.chain`, calls, template/shell expansions: code, not literals.
function isCodeExpression(value) {
  return /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/.test(value) || /[()[\]{}`$<>]/.test(value);
}

const ENV_ASSIGNMENT_RE = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]{0,127})[ \t]*=[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s#]+))/gm;
const QUOTED_ASSIGNMENT_RE = /(?<![A-Za-z0-9_.-])(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,127})\1[ \t]*[:=][ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)')/g;
const YAML_ASSIGNMENT_RE = /^[ \t]*(?:-[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]{0,127})[ \t]*:[ \t]*([A-Za-z0-9_\-+/=~]{16,})[ \t]*$/gm;

const YAML_BLOCK_KEY_RE = /^([ \t]*)(?:-[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]{0,127})[ \t]*:[ \t]*(?:[|>](?:[-+][0-9]?|[0-9][-+]?)?)?[ \t]*(?=\r?\n(?:[ \t]*\r?\n)*([ \t]+)([^\r\n]+))/gm;

function hasSecretAssignment(text) {
  for (const match of text.matchAll(ENV_ASSIGNMENT_RE)) {
    const [, name, doubleQuoted, singleQuoted, bare] = match;
    if (!isSecretName(name)) continue;
    const value = doubleQuoted ?? singleQuoted ?? bare;
    if (bare !== undefined && isCodeExpression(bare)) continue;
    if (isPlausibleSecretValue(value)) return true;
  }
  for (const match of text.matchAll(QUOTED_ASSIGNMENT_RE)) {
    const [, , name, doubleQuoted, singleQuoted] = match;
    if (isSecretName(name) && isPlausibleSecretValue(doubleQuoted ?? singleQuoted)) return true;
  }
  // Secret-named YAML keys whose value continues on indented lines (block
  // scalars `|`, `>-`, or a bare `key:`) are blocked conservatively.
  for (const match of text.matchAll(YAML_BLOCK_KEY_RE)) {
    const [, indent, name, nextIndent, value] = match;
    if (isSecretName(name) && nextIndent.length > indent.length && isPlausibleSecretValue(value.trim())) return true;
  }
  for (const match of text.matchAll(YAML_ASSIGNMENT_RE)) {
    const [, name, value] = match;
    if (isSecretName(name) && isPlausibleSecretValue(value)) return true;
  }
  return false;
}

const SCAN_BEARER_RE = /\b(?:Bearer|Basic)[ \t]+([A-Za-z0-9._~+/=-]{16,})/gi;
// Any scheme: `Authorization: Token abc...`, `authorization = "Digest ..."`.
const SCAN_AUTHORIZATION_RE = /\bauthorization"?[ \t]*[:=][ \t]*["']?(?:[A-Za-z][A-Za-z0-9_-]*[ \t]+)?([A-Za-z0-9._~+/=-]{16,})/gi;

function hasBearerCredential(text) {
  for (const re of [SCAN_BEARER_RE, SCAN_AUTHORIZATION_RE]) {
    for (const match of text.matchAll(re)) {
      if (isPlausibleSecretValue(match[1])) return true;
    }
  }
  return false;
}

// True when `text` carries secret material that must not leave the machine.
export function containsSecret(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  if (PEM_HEADER_RE.test(text)) return true;
  if (redactStrong(text) !== text) return true;
  return hasBearerCredential(text) || hasSecretAssignment(text);
}
