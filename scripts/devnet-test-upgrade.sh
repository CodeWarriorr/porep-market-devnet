#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

deployment_id="${1:?deployment ID is required}"
source_arg="${2:-}"
contracts_csv="${3:?comma-separated contracts are required}"
source_arg="${source_arg#source=}"
contracts_csv="${contracts_csv#contracts=}"
bash "${DEVNET_ROOT}/scripts/devnet-use-deployment.sh" "${deployment_id}" latest

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
run_dir="${DEVNET_ROOT}/.runtime/runs/${timestamp}-upgrade-continuity-${deployment_id}"
mkdir -p "${run_dir}"

SCENARIO_RUN_DIR="${run_dir}" \
UPGRADE_PHASE=before \
UPGRADE_CONTRACTS="${contracts_csv}" \
  npm --prefix "${DEVNET_ROOT}/e2e" run scenario -- upgrade-continuity

bash "${DEVNET_ROOT}/scripts/devnet-upgrade.sh" \
  "${deployment_id}" "${source_arg}" "${contracts_csv}"

SCENARIO_RUN_DIR="${run_dir}" \
UPGRADE_PHASE=after \
UPGRADE_CONTRACTS="${contracts_csv}" \
  npm --prefix "${DEVNET_ROOT}/e2e" run scenario -- upgrade-continuity

printf 'upgrade continuity artifacts: %s\n' "${run_dir}"
