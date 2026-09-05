// Zero-dependency lexical audit used by the reset-credit re-arm structural
// guard. It tokenizes src/server.js (strings, template literals, comments and
// regex literals are skipped or kept opaque) and then ENUMERATES, at the token
// level with bracket-depth tracking:
//   - every reference to `forwardRequest` (definition, call, or anything else
//     such as an alias — the latter is a violation),
//   - the retry argument (6th) of every call, checked against an allowlist,
//   - every binding or write of `retryCount` (assignment incl. logical/bitwise
//     compound forms, ++/--, destructuring targets, for-in/of targets, let/
//     const/var and parameter shadowing), which must all sit inside the
//     `restartRetryCycle` helper except the single forwardRequest parameter.
// Text matching would let a parenthesised argument, an alias, or a
// destructuring reset slip through (Codex cross-model review, 2026-09-06).

const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'finally',
  'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of',
  'return', 'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void',
  'while', 'with', 'yield', 'static', 'get', 'set',
]);
// After these a `/` starts a regex literal rather than a division.
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);
const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=',
  '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%',
  '&', '|', '^', '!', '~', '?', ':', '=', '.', '@', '#',
];
export const ASSIGNMENT_OPS = new Set([
  '=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=',
  '^=', '&&=', '||=', '??=',
]);
const OPENERS = { '(': ')', '[': ']', '{': '}' };

function isIdentStart(ch) { return /[A-Za-z_$]/.test(ch); }
function isIdentPart(ch) { return /[\w$]/.test(ch); }

/** Tokenize JavaScript source; comments and whitespace are dropped. */
export function tokenizeJs(source) {
  const tokens = [];
  const templateStack = []; // brace depth at which each open `${` resumes its template
  let braceDepth = 0;
  let i = 0;
  let line = 1;
  const push = (type, value, start) => tokens.push({ type, value, start, end: i, line });
  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === 'num' || prev.type === 'str' || prev.type === 'tpl' || prev.type === 'regex') return false;
    if (prev.type === 'ident') return REGEX_AFTER_KEYWORD.has(prev.value);
    return !(prev.value === ')' || prev.value === ']');
  };
  const scanTemplate = () => {
    // called with i just past a "`" or a template-resuming "}"
    const start = i;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '\n') line++;
      if (ch === '`') { i++; push('tpl', source.slice(start, i), start); return; }
      if (ch === '$' && source[i + 1] === '{') {
        i += 2;
        push('tpl', source.slice(start, i), start);
        templateStack.push(braceDepth);
        braceDepth++;
        push('punct', '${', i - 2);
        return;
      }
      i++;
    }
    throw new Error('unterminated template literal');
  };
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') { line++; i++; continue; }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated block comment');
      line += (source.slice(i, end).match(/\n/g) || []).length;
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      i++;
      while (i < source.length && source[i] !== ch) {
        if (source[i] === '\\') i++;
        if (source[i] === '\n') throw new Error(`unterminated string at line ${line}`);
        i++;
      }
      i++;
      push('str', source.slice(start, i), start);
      continue;
    }
    if (ch === '`') { i++; scanTemplate(); continue; }
    if (ch === '/' && regexAllowed()) {
      const start = i;
      i++;
      let inClass = false;
      while (i < source.length) {
        const c = source[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '\n') throw new Error(`unterminated regex at line ${line}`);
        if (inClass) { if (c === ']') inClass = false; i++; continue; }
        if (c === '[') { inClass = true; i++; continue; }
        if (c === '/') { i++; break; }
        i++;
      }
      while (i < source.length && isIdentPart(source[i])) i++;
      push('regex', source.slice(start, i), start);
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i])) i++;
      push('ident', source.slice(start, i), start);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(source[i + 1] || ''))) {
      const start = i;
      i++;
      while (i < source.length && /[\w.]/.test(source[i])) i++;
      push('num', source.slice(start, i), start);
      continue;
    }
    const punct = PUNCTUATORS.find(p => source.startsWith(p, i));
    if (!punct) throw new Error(`unexpected character ${JSON.stringify(ch)} at line ${line}`);
    const start = i;
    i += punct.length;
    if (punct === '{') braceDepth++;
    if (punct === '}') {
      braceDepth--;
      if (templateStack.length && templateStack[templateStack.length - 1] === braceDepth) {
        templateStack.pop();
        push('punct', '}', start);
        scanTemplate();
        continue;
      }
    }
    push('punct', punct, start);
  }
  if (templateStack.length) throw new Error('unterminated template expression');
  return tokens;
}

function isPunct(token, value) { return Boolean(token) && token.type === 'punct' && token.value === value; }
function isIdent(token, value) { return Boolean(token) && token.type === 'ident' && (value === undefined || token.value === value); }
function isKeyword(token) { return isIdent(token) && KEYWORDS.has(token.value); }

/** For each token index, the index of its matching bracket (both directions). */
function matchBrackets(tokens) {
  const match = new Array(tokens.length).fill(-1);
  const stack = [];
  tokens.forEach((token, index) => {
    if (token.type !== 'punct') return;
    if (OPENERS[token.value] || token.value === '${') { stack.push(index); return; }
    if (token.value === ')' || token.value === ']' || token.value === '}') {
      const open = stack.pop();
      if (open === undefined) throw new Error(`unbalanced ${token.value} at line ${token.line}`);
      const expected = tokens[open].value === '${' ? '}' : OPENERS[tokens[open].value];
      if (expected !== token.value) throw new Error(`mismatched ${tokens[open].value}…${token.value} at line ${token.line}`);
      match[open] = index;
      match[index] = open;
    }
  });
  if (stack.length) throw new Error(`unbalanced ${tokens[stack[0]].value} at line ${tokens[stack[0]].line}`);
  return match;
}

/** Split the tokens strictly between open/close into top-level comma groups. */
function splitArgs(tokens, match, open) {
  const groups = [];
  let current = [];
  for (let k = open + 1; k < match[open]; k++) {
    const token = tokens[k];
    if (token.type === 'punct' && (OPENERS[token.value] || token.value === '${')) {
      current.push(...tokens.slice(k, match[k] + 1));
      k = match[k];
      continue;
    }
    if (isPunct(token, ',')) { groups.push(current); current = []; continue; }
    current.push(token);
  }
  if (current.length || groups.length) groups.push(current);
  return groups;
}

const argText = tokens => tokens.map(t => t.value).join(' ');

/**
 * Classify one `param` identifier token: 'read', 'write', 'binding', 'key'
 * (object property name / member access — not the variable), or 'param' (the
 * parameter of `fn` itself).
 */
function classifyParamToken(tokens, match, index, fn) {
  const prev = tokens[index - 1];
  const next = tokens[index + 1];
  if (isPunct(prev, '.') || isPunct(prev, '?.')) return 'key';
  if (isPunct(next, ':') && (isPunct(prev, '{') || isPunct(prev, ','))) return 'key';
  if (next && next.type === 'punct' && ASSIGNMENT_OPS.has(next.value)) return 'write';
  if (isPunct(next, '++') || isPunct(next, '--') || isPunct(prev, '++') || isPunct(prev, '--')) return 'write';
  if (isIdent(prev, 'let') || isIdent(prev, 'const') || isIdent(prev, 'var')) return 'binding';
  if (isIdent(next, 'of') || isIdent(next, 'in')) return 'write';
  // Walk the enclosing brackets outward: destructuring targets, declarations,
  // and parameter lists bind or write the identifier; a call or grouping
  // makes it a plain read.
  let k = index - 1;
  let depth = 0;
  while (k >= 0) {
    const token = tokens[k];
    if (token.type === 'punct') {
      if (token.value === ')' || token.value === ']' || token.value === '}') { depth++; k--; continue; }
      if (OPENERS[token.value] || token.value === '${') {
        if (depth > 0) { depth--; k--; continue; }
        const close = match[k];
        const afterClose = tokens[close + 1];
        const beforeOpen = tokens[k - 1];
        if (token.value === '${') return 'read';
        if (token.value === '{' || token.value === '[') {
          if (isPunct(afterClose, '=')) return 'write';
          if (isIdent(beforeOpen, 'let') || isIdent(beforeOpen, 'const') || isIdent(beforeOpen, 'var')) return 'binding';
          k--; // nested pattern or object literal — keep walking outward
          continue;
        }
        // '('
        if (isPunct(afterClose, '=>')) return 'binding';
        if (isIdent(beforeOpen, 'function')) return 'binding';
        if (isIdent(beforeOpen) && !isKeyword(beforeOpen)) {
          if (isIdent(tokens[k - 2], 'function')) return beforeOpen.value === fn ? 'param' : 'binding';
          if (isPunct(afterClose, '{')) return 'binding'; // method shorthand
          return 'read'; // call argument
        }
        return 'read'; // grouping / control-flow parenthesis
      }
    }
    k--;
  }
  return 'read';
}

/**
 * Audit `source` for the retry-cycle invariants. Returns { violations, calls,
 * writes, helper }; an empty `violations` array means every recursion and
 * every write is accounted for.
 */
export function auditRetryCycle(source, {
  fn = 'forwardRequest',
  param = 'retryCount',
  paramIndex = 5,
  helper = 'restartRetryCycle',
  allowedRetryArgs = ['0', `${'retryCount'} + 1`, 'retryCount'],
} = {}) {
  const tokens = tokenizeJs(source);
  const match = matchBrackets(tokens);
  const violations = [];
  const calls = [];
  const writes = [];
  const allowed = new Set(allowedRetryArgs.map(a => a.replace(/\s+/g, ' ')));

  // The single definition and the position of the retry parameter.
  const defs = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token, index }) => isIdent(token, fn) && isIdent(tokens[index - 1], 'function'));
  if (defs.length !== 1) violations.push(`expected exactly one function ${fn}, found ${defs.length}`);
  let paramTokenIndex = -1;
  if (defs.length === 1) {
    const open = defs[0].index + 1;
    const params = splitArgs(tokens, match, open);
    const retryParam = params[paramIndex] || [];
    if (retryParam.length !== 1 || !isIdent(retryParam[0], param)) {
      violations.push(`parameter ${paramIndex} of ${fn} is "${argText(retryParam)}", expected ${param}`);
    } else {
      paramTokenIndex = tokens.indexOf(retryParam[0]);
    }
  }

  // The helper body range.
  const helperDecl = tokens.findIndex((token, index) => isIdent(token, helper)
    && isIdent(tokens[index - 1], 'const') && isPunct(tokens[index + 1], '='));
  let helperRange = null;
  if (helperDecl < 0) {
    violations.push(`helper const ${helper} = … not found`);
  } else {
    const bodyOpen = tokens.findIndex((token, index) => index > helperDecl && isPunct(token, '{'));
    if (bodyOpen < 0 || !isPunct(tokens[bodyOpen - 1], '=>')) violations.push(`helper ${helper} must be an arrow function with a block body`);
    else helperRange = [bodyOpen, match[bodyOpen]];
  }

  // Every reference to fn.
  tokens.forEach((token, index) => {
    if (!isIdent(token, fn)) return;
    if (isIdent(tokens[index - 1], 'function')) return; // the definition
    if (isPunct(tokens[index - 1], '.')) return; // a property named like fn (hooks.forwardRequest) is not the function
    if (!isPunct(tokens[index + 1], '(')) {
      violations.push(`line ${token.line}: ${fn} referenced without being called (alias / value)`);
      return;
    }
    const args = splitArgs(tokens, match, index + 1);
    const retryArg = argText(args[paramIndex] || []);
    calls.push({ line: token.line, retryArg });
    if (!allowed.has(retryArg)) {
      violations.push(`line ${token.line}: ${fn}(…) retry argument "${retryArg}" is not allowlisted`);
    }
  });

  // Every binding / write of param.
  tokens.forEach((token, index) => {
    if (!isIdent(token, param) || index === paramTokenIndex) return;
    const kind = classifyParamToken(tokens, match, index, fn);
    if (kind === 'read' || kind === 'key') return;
    if (kind === 'param') { violations.push(`line ${token.line}: second ${fn} parameter named ${param}`); return; }
    if (kind === 'binding') { violations.push(`line ${token.line}: ${param} is re-bound (shadowing declaration / parameter / pattern)`); return; }
    const inHelper = helperRange && index > helperRange[0] && index < helperRange[1];
    writes.push({ line: token.line, inHelper, text: argText(tokens.slice(index, index + 3)) });
    if (!inHelper) violations.push(`line ${token.line}: ${param} written outside ${helper}(): ${argText(tokens.slice(index - 1, index + 4))}`);
  });
  if (helperRange) {
    const helperWrites = writes.filter(w => w.inHelper);
    if (helperWrites.length !== 1 || helperWrites[0].text !== `${param} = 0`) {
      violations.push(`${helper}() must contain exactly one write "${param} = 0", found: ${helperWrites.map(w => w.text).join(' | ') || 'none'}`);
    }
  }
  return { violations, calls, writes, helperRange, tokens };
}
