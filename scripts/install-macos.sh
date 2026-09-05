#!/usr/bin/env bash

set -euo pipefail

package_spec=""
install_prefix=""
check_only=false

usage() {
  cat <<'EOF'
Usage: install-macos.sh --source <npm-spec-or-tarball> [--prefix <path>]
       install-macos.sh --check-only

Install a pinned TeamCodex package on the current macOS machine.
The installer never reads, copies, or synchronizes TeamClaude/Codex credentials.
Run `teamclaude login` or `teamclaude import` separately on each Mac.
EOF
}

fail() {
  printf 'TeamCodex macOS installer: %s\n' "$1" >&2
  exit 2
}

while (($# > 0)); do
  case "$1" in
    --source)
      (($# >= 2)) || fail '--source requires an npm spec or tarball path'
      package_spec="$2"
      shift 2
      ;;
    --check-only)
      check_only=true
      shift
      ;;
    --prefix)
      (($# >= 2)) || fail '--prefix requires an absolute path'
      install_prefix="$2"
      [[ "$install_prefix" == /* ]] || fail '--prefix must be an absolute path'
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option '$1'"
      ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || fail 'macOS (Darwin) is required'
command -v node >/dev/null 2>&1 || fail 'Node.js 18 or newer is required (node not found)'
command -v npm >/dev/null 2>&1 || fail 'npm is required (npm not found)'

node_version="$(node -p 'process.versions.node' 2>/dev/null)" \
  || fail 'could not determine the Node.js version'
node_major="${node_version%%.*}"
[[ "$node_major" =~ ^[0-9]+$ ]] || fail "invalid Node.js version '$node_version'"
((node_major >= 18)) || fail "Node.js 18 or newer is required (found $node_version)"

if [[ "$check_only" == true ]]; then
  printf 'TeamCodex macOS installer (check-only)\n'
  printf '  platform: Darwin/%s\n' "$(uname -m)"
  printf '  node: %s\n' "$node_version"
  printf '  npm: %s\n' "$(npm --version)"
  printf '  source: %s\n' "${package_spec:-not specified (required for install)}"
  printf '  credentials/config: untouched (login/import must run separately on this Mac)\n'
  exit 0
fi

[[ -n "$package_spec" ]] || fail '--source is required for installation'
[[ "${package_spec:0:1}" != "-" ]] || fail '--source must be a package spec or tarball path, not an option'

printf 'Installing %s globally on this Mac...\n' "$package_spec"
install_args=(install --global --ignore-scripts --no-fund --no-audit)
if [[ -n "$install_prefix" ]]; then
  install_args+=(--prefix "$install_prefix")
fi
npm "${install_args[@]}" "$package_spec"

if [[ -n "$install_prefix" ]]; then
  teamclaude_bin="$install_prefix/bin/teamclaude"
  teamcodex_bin="$install_prefix/bin/teamcodex"
else
  teamclaude_bin="$(command -v teamclaude || true)"
  teamcodex_bin="$(command -v teamcodex || true)"
fi
[[ -x "$teamclaude_bin" ]] || fail 'teamclaude command was not installed'
[[ -x "$teamcodex_bin" ]] || fail 'teamcodex command was not installed'
printf 'Installed commands:\n'
printf '  teamclaude: %s\n' "$teamclaude_bin"
printf '  teamcodex:  %s\n' "$teamcodex_bin"
printf "Next: run 'teamclaude login'/'teamclaude import' and 'teamclaude server' on this Mac.\n"
