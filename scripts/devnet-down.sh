#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/devnet-common.sh"
devnet_require_command docker
exec node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms "${DEVNET_LIFECYCLE_TIMEOUT_MS}" -- \
  bash -c 'source "$1"; devnet_compose down' devnet-down "${DEVNET_ROOT}/scripts/devnet-common.sh"
