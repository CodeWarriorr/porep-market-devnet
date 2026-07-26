#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/devnet-common.sh"
devnet_require_command docker
service="${1:-}"
if [[ -n "${service}" ]]; then devnet_require_service "${service}"; fi
if [[ -n "${service}" ]]; then
  exec node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms 30000 -- \
    bash -c 'source "$1"; devnet_compose logs --tail 300 --since 30m "$2"' devnet-logs "${DEVNET_ROOT}/scripts/devnet-common.sh" "${service}"
fi
exec node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms 30000 -- \
  bash -c 'source "$1"; devnet_compose logs --tail 300 --since 30m' devnet-logs "${DEVNET_ROOT}/scripts/devnet-common.sh"
