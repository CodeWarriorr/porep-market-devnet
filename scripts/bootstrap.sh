#!/usr/bin/env bash
set -euo pipefail

script_directory="${BASH_SOURCE[0]%/*}"
repository_root="$(cd -- "$script_directory/.." && pwd -P)"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "bootstrap requires $1 on PATH" >&2
    exit 1
  }
}

require_command node
require_command npm
require_command git
require_command just

run_with_timeout() {
  local timeout_ms="$1"
  shift
  node "$repository_root/scripts/run-with-timeout.mjs" --timeout-ms "$timeout_ms" -- "$@"
}

node_major="$(run_with_timeout 15000 node -p 'process.versions.node.split(".")[0]')"
if ! [[ "$node_major" =~ ^[0-9]+$ ]] || ((node_major < 20)); then
  echo "bootstrap requires Node.js 20 or newer" >&2
  exit 1
fi

run_with_timeout 600000 npm ci --prefix "$repository_root/tools" >/dev/null
run_with_timeout 600000 npm ci --prefix "$repository_root/e2e" >/dev/null
run_with_timeout 60000 npm --prefix "$repository_root/tools" run cli -- lock verify >/dev/null
run_with_timeout 1200000 npm --prefix "$repository_root/tools" run cli -- sources fetch >/dev/null
verified_sources="$(run_with_timeout 300000 npm --prefix "$repository_root/tools" run cli -- sources verify)"

while IFS=$'\t' read -r name managed_path expected_commit actual_commit _; do
  if [[ -n "$actual_commit" ]]; then
    printf '%s\t%s\t%s\n' "$name" "$actual_commit" "$managed_path"
  fi
done <<< "$verified_sources"
