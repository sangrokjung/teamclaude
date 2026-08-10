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
  };
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
  local value="\${raw%%+*}"
  local build=""
  local core="\${value%%-*}"
  local prerelease=""
  local -a parts identifiers
  if [[ "$raw" == *+* ]]; then
    build="\${raw#*+}"
    [[ "$build" =~ "^[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*$" ]] || return 1
  fi
  [[ "$value" == *-* ]] && prerelease="\${value#*-}"
  parts=(\${(s:.:)core})
  [[ \${#parts} -eq 3 ]] || return 1
  local part
  for part in $parts; do
    [[ "$part" =~ "^(0|[1-9][0-9]*)$" ]] || return 1
  done
  if [[ -n "$prerelease" ]]; then
    identifiers=(\${(s:.:)prerelease})
    [[ \${#identifiers} -gt 0 ]] || return 1
    for part in $identifiers; do
      [[ "$part" =~ "^[0-9A-Za-z-]+$" ]] || return 1
      [[ "$part" != <-> || "$part" =~ "^(0|[1-9][0-9]*)$" ]] || return 1
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

async function backupTarget(path) {
  const stats = await pathInfo(path);
  if (!stats) return { kind: 'none', backupPath: null };
  const kind = targetKind(stats);
  if (kind === 'unsupported') throw new Error(`Refusing to replace unsupported path: ${path}`);
  const backupPath = await nextBackupPath(path);
  const integrity = kind === 'file'
    ? { sha256: digest(await readFile(path)), mode: stats.mode & 0o7777 }
    : { linkTarget: await readlink(path) };
  await rename(path, backupPath);
  return { kind, backupPath, ...integrity };
}

async function readInstallState(paths) {
  const stats = await pathInfo(paths.statePath);
  if (!stats) return null;
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Refusing to use non-file wrapper state: ${paths.statePath}`);
  }
  let state;
  try {
    state = JSON.parse(await readFile(paths.statePath, 'utf8'));
  } catch (error) {
    throw new Error(`Refusing to overwrite invalid wrapper state: ${error.message}`);
  }
  if (state.version !== STATE_VERSION
    || state.wrapperPath !== paths.wrapperPath
    || state.vendorShimPath !== paths.vendorShimPath
    || !state.installed?.wrapperSha256
    || !state.installed?.vendorSha256
    || !state.originals?.wrapper
    || !state.originals?.vendor) {
    throw new Error(`Refusing to use mismatched wrapper state: ${paths.statePath}`);
  }
  for (const [name, target] of [
    ['wrapper', paths.wrapperPath],
    ['vendor', paths.vendorShimPath],
  ]) {
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

async function verifyManagedTarget(path, signature, expectedDigest) {
  const stats = await pathInfo(path);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Managed file changed after installation; refusing to uninstall: ${path}`);
  }
  const content = await readFile(path, 'utf8');
  const signatureLine = `# ${signature}`;
  if (!content.split('\n').includes(signatureLine) || digest(content) !== expectedDigest) {
    throw new Error(`Managed file changed after installation; refusing to uninstall: ${path}`);
  }
  return content;
}

async function hasManagedSignature(path, signature) {
  const stats = await pathInfo(path);
  if (!stats?.isFile() || stats.isSymbolicLink()) return false;
  return (await readFile(path, 'utf8')).split('\n').includes(`# ${signature}`);
}

async function rollbackFreshInstall(paths, originals, installedDigests) {
  for (const [name, path] of [
    ['wrapper', paths.wrapperPath],
    ['vendor', paths.vendorShimPath],
  ]) {
    const stats = await pathInfo(path);
    if (stats?.isFile() && !stats.isSymbolicLink()) {
      const content = await readFile(path, 'utf8').catch(() => null);
      if (content != null && digest(content) === installedDigests[name]) await unlink(path);
    }
    const original = originals[name] ?? { kind: 'none', backupPath: null };
    if (original.kind !== 'none' && await pathInfo(original.backupPath)) {
      await rename(original.backupPath, path);
    }
  }
  await unlink(paths.statePath).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
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

export async function installClaudeWrapper({ homeDir, teamcodexBin } = {}) {
  const paths = wrapperPaths(homeDir);
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
  const existingState = await readInstallState(paths);
  if (existingState) {
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
      return {
        wrapperPath: paths.wrapperPath,
        vendorShimPath: paths.vendorShimPath,
        statePath: paths.statePath,
      };
    }
    await atomicWrite(paths.wrapperPath, wrapper, 0o755);
    await atomicWrite(paths.vendorShimPath, vendor, 0o755);
    existingState.installed = {
      wrapperSha256: installedDigests.wrapper,
      vendorSha256: installedDigests.vendor,
    };
    await atomicWrite(paths.statePath, `${JSON.stringify(existingState, null, 2)}\n`, 0o600);
    return {
      wrapperPath: paths.wrapperPath,
      vendorShimPath: paths.vendorShimPath,
      statePath: paths.statePath,
    };
  }

  const originals = {};
  try {
    for (const path of [paths.wrapperPath, paths.vendorShimPath]) {
      const stats = await pathInfo(path);
      if (stats && targetKind(stats) === 'unsupported') {
        throw new Error(`Refusing to replace unsupported path: ${path}`);
      }
    }
    originals.wrapper = await backupTarget(paths.wrapperPath);
    originals.vendor = await backupTarget(paths.vendorShimPath);
    await atomicWrite(paths.wrapperPath, wrapper, 0o755);
    await atomicWrite(paths.vendorShimPath, vendor, 0o755);
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
    await atomicWrite(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  } catch (error) {
    if (originals.wrapper || originals.vendor) {
      await rollbackFreshInstall(paths, originals, installedDigests).catch(() => {});
    }
    throw error;
  }

  return {
    wrapperPath: paths.wrapperPath,
    vendorShimPath: paths.vendorShimPath,
    statePath: paths.statePath,
  };
}

export async function uninstallClaudeWrapper({ homeDir } = {}) {
  const paths = wrapperPaths(homeDir);
  const state = await readInstallState(paths);
  if (!state) {
    const managedFilesRemain = await hasManagedSignature(
      paths.wrapperPath,
      CLAUDE_WRAPPER_SIGNATURE,
    ) || await hasManagedSignature(paths.vendorShimPath, CLAUDE_VENDOR_SIGNATURE);
    if (managedFilesRemain) {
      throw new Error(`Wrapper state is missing; refusing to uninstall managed files: ${paths.statePath}`);
    }
    return {
      wrapperPath: paths.wrapperPath,
      vendorShimPath: paths.vendorShimPath,
      statePath: paths.statePath,
    };
  }
  await verifyManagedTarget(
    paths.wrapperPath,
    CLAUDE_WRAPPER_SIGNATURE,
    state.installed.wrapperSha256,
  );
  await verifyManagedTarget(
    paths.vendorShimPath,
    CLAUDE_VENDOR_SIGNATURE,
    state.installed.vendorSha256,
  );
  for (const original of Object.values(state.originals)) await verifyOriginalBackup(original);

  for (const [name, path] of [
    ['wrapper', paths.wrapperPath],
    ['vendor', paths.vendorShimPath],
  ]) {
    const original = state.originals[name];
    if (original.kind === 'none') await unlink(path);
    else await rename(original.backupPath, path);
  }
  await unlink(paths.statePath);
  return {
    wrapperPath: paths.wrapperPath,
    vendorShimPath: paths.vendorShimPath,
    statePath: paths.statePath,
  };
}
