import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';

export const CLAUDE_WRAPPER_SIGNATURE = 'teamclaude-transparent-wrapper:v1';
export const CLAUDE_VENDOR_SIGNATURE = 'teamclaude-vendor-shim:v1';

const STATE_VERSION = 1;
const STATE_FILENAME = '.teamclaude-claude-wrapper-state.json';
const TRANSACTION_VERSION = 1;
const TRANSACTION_FILENAME = '.teamclaude-claude-wrapper-transaction.json';

function wrapperPaths(homeDir) {
  if (typeof homeDir !== 'string' || !isAbsolute(homeDir)) {
    throw new Error('homeDir must be an absolute path');
  }
  const binDir = join(homeDir, '.local', 'bin');
  return {
    binDir,
    versionsDir: join(homeDir, '.local', 'share', 'claude', 'versions'),
    wrapperPath: join(binDir, 'claude'),
    vendorShimPath: join(binDir, 'claude-vendor'),
    statePath: join(binDir, STATE_FILENAME),
    transactionPath: join(binDir, TRANSACTION_FILENAME),
  };
}

function managedTargets(paths) {
  return [
    {
      name: 'wrapper',
      path: paths.wrapperPath,
      signature: CLAUDE_WRAPPER_SIGNATURE,
      digestKey: 'wrapperSha256',
    },
    {
      name: 'vendor',
      path: paths.vendorShimPath,
      signature: CLAUDE_VENDOR_SIGNATURE,
      digestKey: 'vendorSha256',
    },
  ];
}

function parseSemanticVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split('.') ?? [];
  if (prerelease.some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    return null;
  }
  return {
    value,
    core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])],
    prerelease,
  };
}

function compareIdentifiers(left, right) {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    const a = BigInt(left);
    const b = BigInt(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareSemanticVersions(left, right) {
  for (let index = 0; index < left.core.length; index++) {
    if (left.core[index] < right.core[index]) return -1;
    if (left.core[index] > right.core[index]) return 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index++) {
    if (left.prerelease[index] == null) return -1;
    if (right.prerelease[index] == null) return 1;
    const compared = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

function errorWithCode(message, exitCode) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function findNewestClaudeVendor({ homeDir, versionsDir } = {}) {
  const paths = wrapperPaths(homeDir);
  const root = versionsDir ?? paths.versionsDir;
  let names;
  try {
    names = await readdir(root);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw errorWithCode(`Claude native versions directory does not exist: ${root}`, 75);
    }
    throw error;
  }
  const candidates = names
    .map(name => ({ name, version: parseSemanticVersion(name) }))
    .filter(candidate => candidate.version)
    .sort((left, right) => compareSemanticVersions(right.version, left.version));
  if (candidates.length === 0) {
    throw errorWithCode(`No semantic-version Claude native binary found in ${root}`, 75);
  }

  let lastNonExecutable = null;
  let lastUnresolvable = null;
  for (const { name } of candidates) {
    const candidate = join(root, name);
    let resolved;
    try {
      resolved = await realpath(candidate);
      if (!(await stat(resolved)).isFile()) {
        lastNonExecutable = candidate;
        continue;
      }
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ELOOP') {
        lastUnresolvable = candidate;
        continue;
      }
      throw error;
    }
    try {
      await access(resolved, fsConstants.X_OK);
      return candidate;
    } catch (error) {
      if (error.code !== 'EACCES') throw error;
      lastNonExecutable = candidate;
    }
  }
  if (lastUnresolvable) {
    throw errorWithCode(`Cannot resolve Claude native candidate (broken link or symlink loop): ${lastUnresolvable}`, 75);
  }
  throw errorWithCode(`Claude native candidate is not executable: ${lastNonExecutable}`, 126);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function renderClaudeWrapper({ teamcodexBin, vendorShimPath }) {
  if (!isAbsolute(teamcodexBin) || !isAbsolute(vendorShimPath)) {
    throw new Error('Wrapper paths must be absolute');
  }
  return `#!/bin/zsh
# ${CLAUDE_WRAPPER_SIGNATURE}
export TEAMCLAUDE_CLAUDE_BIN=${shellQuote(vendorShimPath)}
exec ${shellQuote(teamcodexBin)} run -- "$@"
`;
}

export function renderClaudeVendorShim({ versionsDir, wrapperPath, vendorShimPath }) {
  if (![versionsDir, wrapperPath, vendorShimPath].every(isAbsolute)) {
    throw new Error('Vendor shim paths must be absolute');
  }
  return `#!/bin/zsh
# ${CLAUDE_VENDOR_SIGNATURE}
setopt local_options no_unset

versions_dir=${shellQuote(versionsDir)}
wrapper_path=${shellQuote(wrapperPath)}
shim_path=${shellQuote(vendorShimPath)}

fail_closed() {
  print -u2 -r -- "[TeamClaude] claude-vendor: $1"
  exit "$2"
}

is_semver() {
  local raw="$1"
  local precedence="\${raw%%+*}"
  local prerelease=""
  local -a identifiers
  [[ "$raw" =~ "^(0|[1-9][0-9]*)[.](0|[1-9][0-9]*)[.](0|[1-9][0-9]*)(-([0-9A-Za-z-]+([.][0-9A-Za-z-]+)*))?([+]([0-9A-Za-z-]+([.][0-9A-Za-z-]+)*))?$" ]] || return 1
  [[ "$precedence" == *-* ]] && prerelease="\${precedence#*-}"
  if [[ -n "$prerelease" ]]; then
    identifiers=(\${(s:.:)prerelease})
    local identifier
    for identifier in $identifiers; do
      [[ "$identifier" != <-> || "$identifier" =~ "^(0|[1-9][0-9]*)$" ]] || return 1
    done
  fi
  return 0
}

semver_gt() {
  local left="\${1%%+*}" right="\${2%%+*}"
  local left_core="\${left%%-*}" right_core="\${right%%-*}"
  local left_pre="" right_pre=""
  local -a left_parts right_parts left_ids right_ids
  [[ "$left" == *-* ]] && left_pre="\${left#*-}"
  [[ "$right" == *-* ]] && right_pre="\${right#*-}"
  left_parts=(\${(s:.:)left_core})
  right_parts=(\${(s:.:)right_core})
  local index
  for index in 1 2 3; do
    (( left_parts[index] > right_parts[index] )) && return 0
    (( left_parts[index] < right_parts[index] )) && return 1
  done
  [[ -z "$left_pre" && -n "$right_pre" ]] && return 0
  [[ -n "$left_pre" && -z "$right_pre" ]] && return 1
  [[ -z "$left_pre" ]] && return 1
  left_ids=(\${(s:.:)left_pre})
  right_ids=(\${(s:.:)right_pre})
  local length=$(( \${#left_ids} > \${#right_ids} ? \${#left_ids} : \${#right_ids} ))
  local left_id right_id
  for (( index = 1; index <= length; index++ )); do
    (( index > \${#left_ids} )) && return 1
    (( index > \${#right_ids} )) && return 0
    left_id="$left_ids[index]"
    right_id="$right_ids[index]"
    [[ "$left_id" == "$right_id" ]] && continue
    if [[ "$left_id" == <-> && "$right_id" == <-> ]]; then
      (( left_id > right_id )) && return 0
      return 1
    fi
    [[ "$left_id" == <-> ]] && return 1
    [[ "$right_id" == <-> ]] && return 0
    [[ "$left_id" > "$right_id" ]] && return 0
    return 1
  done
  return 1
}

[[ -d "$versions_dir" ]] || fail_closed "native versions directory is missing: $versions_dir" 75
wrapper_real="\${wrapper_path:A}"
shim_real="\${shim_path:A}"
selected=""
selected_version=""
semantic_count=0
non_executable_count=0

for candidate in "$versions_dir"/*(N); do
  version="\${candidate:t}"
  is_semver "$version" || continue
  (( semantic_count++ ))
  if [[ -L "$candidate" && ! -e "$candidate" ]]; then
    fail_closed "cannot resolve native candidate (broken link or symlink loop): $candidate" 75
  fi
  candidate_real="\${candidate:A}"
  if [[ "$candidate_real" == "$wrapper_real" || "$candidate_real" == "$shim_real" ]]; then
    fail_closed "native candidate has the same realpath as a wrapper; refusing recursion: $candidate" 75
  fi
  if [[ ! -f "$candidate" || ! -x "$candidate" ]]; then
    (( non_executable_count++ ))
    continue
  fi
  if [[ -z "$selected" ]] || semver_gt "$version" "$selected_version"; then
    selected="$candidate"
    selected_version="$version"
  fi
done

(( semantic_count > 0 )) || fail_closed "no semantic-version native candidate found in $versions_dir" 75
[[ -n "$selected" ]] || fail_closed "native candidate is not executable in $versions_dir" 126
exec "$selected" "$@"
status=$?
print -u2 -r -- "[TeamClaude] claude-vendor: failed to exec $selected (status $status)"
exit $status
`;
}

function digest(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function atomicWrite(path, content, mode) {
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await writeFile(temp, content, { flag: 'wx', mode });
    await chmod(temp, mode);
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function executableRealpath(path, label) {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  let resolved;
  try {
    resolved = await realpath(path);
    if (!(await stat(resolved)).isFile()) throw new Error(`${label} is not a file: ${path}`);
    await access(resolved, fsConstants.X_OK);
  } catch (error) {
    if (error.code === 'EACCES') throw new Error(`${label} is not executable: ${path}`);
    if (error.code === 'ENOENT') throw new Error(`${label} does not exist: ${path}`);
    throw error;
  }
  return resolved;
}

async function nextBackupPath(path) {
  const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 17);
  const prefix = `${path}.teamclaude-backup-${stamp}-${process.pid}`;
  let candidate = prefix;
  let suffix = 0;
  while (await pathInfo(candidate)) {
    suffix += 1;
    candidate = `${prefix}-${suffix}`;
  }
  return candidate;
}

function targetKind(stats) {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  return 'unsupported';
}

async function planOriginalTarget(path) {
  const stats = await pathInfo(path);
  if (!stats) return { kind: 'none', backupPath: null };
  const kind = targetKind(stats);
  if (kind === 'unsupported') throw new Error(`Refusing to replace unsupported path: ${path}`);
  const backupPath = await nextBackupPath(path);
  const integrity = kind === 'file'
    ? { sha256: digest(await readFile(path)), mode: stats.mode & 0o7777 }
    : { linkTarget: await readlink(path) };
  return { kind, backupPath, ...integrity };
}

function validateInstallState(state, paths) {
  if (state.version !== STATE_VERSION
    || state.wrapperPath !== paths.wrapperPath
    || state.vendorShimPath !== paths.vendorShimPath
    || !state.installed?.wrapperSha256
    || !state.installed?.vendorSha256
    || !state.originals?.wrapper
    || !state.originals?.vendor) {
    throw new Error(`Refusing to use mismatched wrapper state: ${paths.statePath}`);
  }
  for (const { name, path: target } of managedTargets(paths)) {
    const original = state.originals[name];
    if (!['none', 'file', 'symlink'].includes(original.kind)) {
      throw new Error(`Refusing to use invalid ${name} backup state`);
    }
    if (original.kind === 'none') {
      if (original.backupPath != null) throw new Error(`Refusing to use invalid ${name} backup path`);
    } else if (typeof original.backupPath !== 'string'
      || dirname(original.backupPath) !== dirname(target)
      || !basename(original.backupPath).startsWith(`${basename(target)}.teamclaude-backup-`)) {
      throw new Error(`Refusing to use unsafe ${name} backup path`);
    }
    if (original.kind === 'file'
      && (typeof original.sha256 !== 'string' || !Number.isInteger(original.mode))) {
      throw new Error(`Refusing to use invalid ${name} file integrity state`);
    }
    if (original.kind === 'symlink' && typeof original.linkTarget !== 'string') {
      throw new Error(`Refusing to use invalid ${name} symlink integrity state`);
    }
  }
  return state;
}

function parseInstallState(content, paths) {
  let state;
  try {
    state = JSON.parse(content);
  } catch (error) {
    throw new Error(`Refusing to overwrite invalid wrapper state: ${error.message}`);
  }
  return validateInstallState(state, paths);
}

async function readInstallStateRecord(paths) {
  const stats = await pathInfo(paths.statePath);
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Refusing to use non-file wrapper state: ${paths.statePath}`);
  }
  const content = await readFile(paths.statePath, 'utf8');
  return { state: parseInstallState(content, paths), content };
}

async function inspectManagedTarget(path, signature) {
  const stats = await pathInfo(path);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Managed file changed after installation: ${path}`);
  }
  const content = await readFile(path, 'utf8');
  const signatureLine = `# ${signature}`;
  if (!content.split('\n').includes(signatureLine)) {
    throw new Error(`Managed file changed after installation: ${path}`);
  }
  return { content, sha256: digest(content), mode: stats.mode & 0o7777 };
}

async function verifyManagedTarget(path, signature, expectedDigest, expectedMode = null) {
  const inspected = await inspectManagedTarget(path, signature);
  if (inspected.sha256 !== expectedDigest
    || (expectedMode != null && inspected.mode !== expectedMode)) {
    throw new Error(`Managed file changed after installation; refusing to uninstall: ${path}`);
  }
  return inspected;
}

async function hasManagedSignature(path, signature) {
  const stats = await pathInfo(path);
  if (!stats?.isFile() || stats.isSymbolicLink()) return false;
  return (await readFile(path, 'utf8')).split('\n').includes(`# ${signature}`);
}

async function hasManagedTargets(paths) {
  for (const { path, signature } of managedTargets(paths)) {
    if (await hasManagedSignature(path, signature)) return true;
  }
  return false;
}

async function verifyOriginalBackup(original) {
  if (original.kind === 'none') return;
  const stats = await pathInfo(original.backupPath);
  if (!stats || targetKind(stats) !== original.kind) {
    throw new Error(`Original backup changed; refusing to uninstall: ${original.backupPath}`);
  }
  if (original.kind === 'file') {
    const contentMatches = digest(await readFile(original.backupPath)) === original.sha256;
    const modeMatches = (stats.mode & 0o7777) === original.mode;
    if (!contentMatches || !modeMatches) {
      throw new Error(`Original backup changed; refusing to uninstall: ${original.backupPath}`);
    }
  } else if (await readlink(original.backupPath) !== original.linkTarget) {
    throw new Error(`Original backup changed; refusing to uninstall: ${original.backupPath}`);
  }
}

function serializeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function validateJournalTarget(target, signature, label) {
  if (!target || typeof target.content !== 'string' || typeof target.sha256 !== 'string'
    || digest(target.content) !== target.sha256
    || !target.content.split('\n').includes(`# ${signature}`)) {
    throw new Error(`Refusing to use invalid ${label} transaction target`);
  }
  return target;
}

function validateTransaction(journal, paths) {
  if (journal.version !== TRANSACTION_VERSION
    || journal.wrapperPath !== paths.wrapperPath
    || journal.vendorShimPath !== paths.vendorShimPath
    || journal.statePath !== paths.statePath) {
    throw new Error(`Refusing to use mismatched wrapper transaction: ${paths.transactionPath}`);
  }
  if (journal.type === 'install-fresh' || journal.type === 'install-update') {
    const state = parseInstallState(journal.stateContent, paths);
    if (journal.type === 'install-update'
      && typeof journal.previousStateSha256 !== 'string') {
      throw new Error('Refusing to use an invalid previous state digest');
    }
    for (const { name, signature, digestKey } of managedTargets(paths)) {
      const target = validateJournalTarget(
        journal.targets?.[name],
        signature,
        name,
      );
      if (state.installed[digestKey] !== target.sha256) {
        throw new Error(`Refusing to use inconsistent ${name} transaction digests`);
      }
    }
    return { journal, state };
  }
  if (journal.type === 'uninstall') {
    const state = parseInstallState(journal.stateContent, paths);
    if (digest(journal.stateContent) !== journal.stateSha256) {
      throw new Error('Refusing to use an inconsistent uninstall state digest');
    }
    return { journal, state };
  }
  throw new Error(`Refusing unknown wrapper transaction type: ${journal.type}`);
}

async function readTransaction(paths) {
  const stats = await pathInfo(paths.transactionPath);
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink() || (stats.mode & 0o7777) !== 0o600) {
    throw new Error(`Refusing to use unsafe wrapper transaction: ${paths.transactionPath}`);
  }
  let journal;
  try {
    journal = JSON.parse(await readFile(paths.transactionPath, 'utf8'));
  } catch (error) {
    throw new Error(`Refusing to use invalid wrapper transaction: ${error.message}`);
  }
  return validateTransaction(journal, paths);
}

async function runTransactionHook(transactionHook, step) {
  if (typeof transactionHook === 'function') await transactionHook(step);
}

async function originalMatchesPath(path, original) {
  const stats = await pathInfo(path);
  if (original.kind === 'none') return stats == null;
  if (!stats || targetKind(stats) !== original.kind) return false;
  if (original.kind === 'file') {
    return digest(await readFile(path)) === original.sha256
      && (stats.mode & 0o7777) === original.mode;
  }
  return await readlink(path) === original.linkTarget;
}

async function restoreOriginalTarget(path, original, signature, managedDigest) {
  if (original.kind === 'none') {
    if (!await pathInfo(path)) return;
    await verifyManagedTarget(path, signature, managedDigest, 0o755);
    await unlink(path);
    return;
  }
  if (await pathInfo(original.backupPath)) {
    await verifyOriginalBackup(original);
    await verifyManagedTarget(path, signature, managedDigest, 0o755);
    await rename(original.backupPath, path);
    return;
  }
  if (!await originalMatchesPath(path, original)) {
    throw new Error(`Original restore is incomplete or changed: ${path}`);
  }
}

async function freshTargetNeedsBackup(path, original, signature, managedDigest) {
  const live = await pathInfo(path);
  if (original.kind === 'none') {
    if (live) await verifyManagedTarget(path, signature, managedDigest);
    return false;
  }
  if (await pathInfo(original.backupPath)) {
    await verifyOriginalBackup(original);
    if (live) await verifyManagedTarget(path, signature, managedDigest);
    return false;
  }
  if (!await originalMatchesPath(path, original)) {
    throw new Error(`Original target changed during install recovery: ${path}`);
  }
  return true;
}

async function writeInstallGeneration(paths, journal, transactionHook, stepPrefix) {
  for (const { name, path } of managedTargets(paths)) {
    await runTransactionHook(transactionHook, `${stepPrefix}:${name}`);
    await atomicWrite(path, journal.targets[name].content, 0o755);
  }
  await runTransactionHook(transactionHook, `${stepPrefix}:state`);
  await atomicWrite(paths.statePath, journal.stateContent, 0o600);
  await unlink(paths.transactionPath);
}

async function resumeFreshInstall(paths, transaction, transactionHook = null) {
  const { journal, state } = transaction;
  const stateRecord = await readInstallStateRecord(paths);
  if (stateRecord && digest(stateRecord.content) !== digest(journal.stateContent)) {
    throw new Error('Install state changed during fresh install recovery');
  }
  const needsBackup = [];
  for (const target of managedTargets(paths)) {
    if (await freshTargetNeedsBackup(
      target.path,
      state.originals[target.name],
      target.signature,
      journal.targets[target.name].sha256,
    )) needsBackup.push(target);
  }
  for (const { name, path } of needsBackup) {
    await rename(path, state.originals[name].backupPath);
  }
  await writeInstallGeneration(paths, journal, transactionHook, 'install:fresh');
}

async function resumeInstallUpdate(paths, transaction, transactionHook = null) {
  const { journal, state } = transaction;
  const stateRecord = await readInstallStateRecord(paths);
  if (!stateRecord) throw new Error('Install update state is missing; refusing recovery');
  const stateDigest = digest(stateRecord.content);
  const nextStateDigest = digest(journal.stateContent);
  if (stateDigest !== journal.previousStateSha256 && stateDigest !== nextStateDigest) {
    throw new Error('Install update state changed during recovery; refusing to resume');
  }
  const currentDigests = stateDigest === nextStateDigest
    ? state.installed
    : stateRecord.state.installed;
  for (const { name, path, signature, digestKey } of managedTargets(paths)) {
    const inspected = await inspectManagedTarget(path, signature);
    const allowed = [currentDigests[digestKey], journal.targets[name].sha256];
    if (!allowed.includes(inspected.sha256)) {
      throw new Error(`Managed ${name} changed during recovery; refusing to resume`);
    }
  }
  await writeInstallGeneration(paths, journal, transactionHook, 'install:update');
}

async function resumeUninstall(paths, transaction, transactionHook = null) {
  const { journal, state } = transaction;
  const stateRecord = await readInstallStateRecord(paths);
  if (!stateRecord) {
    const restored = await Promise.all([
      originalMatchesPath(paths.wrapperPath, state.originals.wrapper),
      originalMatchesPath(paths.vendorShimPath, state.originals.vendor),
    ]);
    if (!restored.every(Boolean)) {
      throw new Error('Uninstall state is missing before all originals were restored');
    }
    await unlink(paths.transactionPath);
    return;
  }
  if (digest(stateRecord.content) !== journal.stateSha256) {
    throw new Error('Install state changed during uninstall; refusing to resume');
  }

  for (const { name, path, signature, digestKey } of managedTargets(paths)) {
    await runTransactionHook(transactionHook, `uninstall:${name}`);
    await restoreOriginalTarget(
      path,
      state.originals[name],
      signature,
      state.installed[digestKey],
    );
  }
  await runTransactionHook(transactionHook, 'uninstall:state');
  await unlink(paths.statePath);
  await unlink(paths.transactionPath);
}

async function recoverPendingTransaction(paths) {
  const transaction = await readTransaction(paths);
  if (!transaction) return;
  if (transaction.journal.type === 'install-fresh') {
    await resumeFreshInstall(paths, transaction);
    return;
  }
  if (transaction.journal.type === 'install-update') {
    await resumeInstallUpdate(paths, transaction);
    return;
  }
  await resumeUninstall(paths, transaction);
}

export async function installClaudeWrapper({ homeDir, teamcodexBin, transactionHook } = {}) {
  const paths = wrapperPaths(homeDir);
  await recoverPendingTransaction(paths);
  const verifiedTeamcodexBin = await executableRealpath(teamcodexBin, 'teamcodexBin');
  await findNewestClaudeVendor({ homeDir, versionsDir: paths.versionsDir });
  await mkdir(paths.binDir, { recursive: true, mode: 0o755 });

  const wrapper = renderClaudeWrapper({
    teamcodexBin: verifiedTeamcodexBin,
    vendorShimPath: paths.vendorShimPath,
  });
  const vendor = renderClaudeVendorShim(paths);
  const installedDigests = {
    wrapper: digest(wrapper),
    vendor: digest(vendor),
  };
  const existingRecord = await readInstallStateRecord(paths);
  if (!existingRecord && await hasManagedTargets(paths)) {
    throw new Error(`Wrapper state is missing; refusing to replace managed files: ${paths.statePath}`);
  }
  if (existingRecord) {
    const existingState = existingRecord.state;
    await verifyManagedTarget(
      paths.wrapperPath,
      CLAUDE_WRAPPER_SIGNATURE,
      existingState.installed.wrapperSha256,
    );
    await verifyManagedTarget(
      paths.vendorShimPath,
      CLAUDE_VENDOR_SIGNATURE,
      existingState.installed.vendorSha256,
    );
    if (existingState.installed.wrapperSha256 === installedDigests.wrapper
      && existingState.installed.vendorSha256 === installedDigests.vendor) {
      await chmod(paths.wrapperPath, 0o755);
      await chmod(paths.vendorShimPath, 0o755);
      await chmod(paths.statePath, 0o600);
      return {
        wrapperPath: paths.wrapperPath,
        vendorShimPath: paths.vendorShimPath,
        statePath: paths.statePath,
      };
    }
    const nextState = {
      ...existingState,
      installed: {
        wrapperSha256: installedDigests.wrapper,
        vendorSha256: installedDigests.vendor,
      },
    };
    const nextStateContent = serializeState(nextState);
    const journal = {
      version: TRANSACTION_VERSION,
      type: 'install-update',
      wrapperPath: paths.wrapperPath,
      vendorShimPath: paths.vendorShimPath,
      statePath: paths.statePath,
      previousStateSha256: digest(existingRecord.content),
      stateContent: nextStateContent,
      targets: {
        wrapper: { content: wrapper, sha256: installedDigests.wrapper },
        vendor: { content: vendor, sha256: installedDigests.vendor },
      },
    };
    await atomicWrite(paths.transactionPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
    await resumeInstallUpdate(paths, { journal, state: nextState }, transactionHook);
    return {
      wrapperPath: paths.wrapperPath,
      vendorShimPath: paths.vendorShimPath,
      statePath: paths.statePath,
    };
  }

  const originals = {};
  for (const { name, path } of managedTargets(paths)) {
    originals[name] = await planOriginalTarget(path);
  }
  const state = {
    version: STATE_VERSION,
    wrapperPath: paths.wrapperPath,
    vendorShimPath: paths.vendorShimPath,
    installed: {
      wrapperSha256: installedDigests.wrapper,
      vendorSha256: installedDigests.vendor,
    },
    originals,
  };
  const journal = {
    version: TRANSACTION_VERSION,
    type: 'install-fresh',
    wrapperPath: paths.wrapperPath,
    vendorShimPath: paths.vendorShimPath,
    statePath: paths.statePath,
    stateContent: serializeState(state),
    targets: {
      wrapper: { content: wrapper, sha256: installedDigests.wrapper },
      vendor: { content: vendor, sha256: installedDigests.vendor },
    },
  };
  await atomicWrite(paths.transactionPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
  await resumeFreshInstall(paths, { journal, state }, transactionHook);

  return {
    wrapperPath: paths.wrapperPath,
    vendorShimPath: paths.vendorShimPath,
    statePath: paths.statePath,
  };
}

export async function uninstallClaudeWrapper({ homeDir, transactionHook } = {}) {
  const paths = wrapperPaths(homeDir);
  await recoverPendingTransaction(paths);
  const stateRecord = await readInstallStateRecord(paths);
  if (!stateRecord) {
    if (await hasManagedTargets(paths)) {
      throw new Error(`Wrapper state is missing; refusing to uninstall managed files: ${paths.statePath}`);
    }
    return {
      wrapperPath: paths.wrapperPath,
      vendorShimPath: paths.vendorShimPath,
      statePath: paths.statePath,
    };
  }
  const { state } = stateRecord;
  await verifyManagedTarget(
    paths.wrapperPath,
    CLAUDE_WRAPPER_SIGNATURE,
    state.installed.wrapperSha256,
    0o755,
  );
  await verifyManagedTarget(
    paths.vendorShimPath,
    CLAUDE_VENDOR_SIGNATURE,
    state.installed.vendorSha256,
    0o755,
  );
  for (const original of Object.values(state.originals)) await verifyOriginalBackup(original);
  const journal = {
    version: TRANSACTION_VERSION,
    type: 'uninstall',
    wrapperPath: paths.wrapperPath,
    vendorShimPath: paths.vendorShimPath,
    statePath: paths.statePath,
    stateContent: stateRecord.content,
    stateSha256: digest(stateRecord.content),
  };
  await atomicWrite(paths.transactionPath, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
  await resumeUninstall(paths, { journal, state }, transactionHook);
  return {
    wrapperPath: paths.wrapperPath,
    vendorShimPath: paths.vendorShimPath,
    statePath: paths.statePath,
  };
}
