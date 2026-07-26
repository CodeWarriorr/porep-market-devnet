#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

devnet_require_command docker
devnet_require_runtime_tree
devnet_require_ownership_marker

source_output="$(npm --prefix "${DEVNET_ROOT}/tools" run cli -- sources verify)"
curio_commit="$(awk -F '\t' '$1 == "curio" {print $3}' <<<"${source_output}")"
porep_commit="$(awk -F '\t' '$1 == "porep_market" {print $3}' <<<"${source_output}")"
filecoin_pay_commit="$(awk -F '\t' '$1 == "filecoin_pay" {print $3}' <<<"${source_output}")"
[[ "${curio_commit}" =~ ^[0-9a-f]{40}$ && "${porep_commit}" =~ ^[0-9a-f]{40}$ && "${filecoin_pay_commit}" =~ ^[0-9a-f]{40}$ ]] ||
  devnet_die "contract source pins are unavailable"

mkdir -p "${DEVNET_ROOT}/.runtime/contracts"
image="${DEVNET_IMAGE_NAMESPACE}/curio-all-in-one:${curio_commit:0:12}"

node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms 600000 -- \
  docker run --rm --platform "$(jq -r '.platform' "${DEVNET_BUILD_DIR}/images.json")" \
  --entrypoint forge \
  -v "${DEVNET_ROOT}:/workspace:rw" \
  -v "${DEVNET_ROOT}/.cache/sources/porep_market/${porep_commit}:/workspace/.cache/sources/porep_market/${porep_commit}:ro" \
  -v "${DEVNET_ROOT}/.cache/sources/filecoin_pay/${filecoin_pay_commit}:/workspace/.cache/sources/filecoin_pay/${filecoin_pay_commit}:ro" \
  -w /workspace/contracts \
  "${image}" test
