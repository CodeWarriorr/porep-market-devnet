#!/usr/bin/env bash
set -euo pipefail
source "$(cd -L "$(dirname "${BASH_SOURCE[0]}")" && pwd -L)/devnet-common.sh"

deployment_id="${1:?deployment ID is required}"
source_arg="${2:-}"
contracts_csv="${3:?comma-separated contracts are required}"
source_arg="${source_arg#source=}"
contracts_csv="${contracts_csv#contracts=}"
[[ "${deployment_id}" =~ ^deployment-[A-Za-z0-9][A-Za-z0-9._-]*$ ]] ||
  devnet_die "deployment ID is invalid"
if [[ -n "${source_arg}" && "${source_arg}" != /* ]]; then
  devnet_die "PoRep Market source must be an absolute path"
fi

deployment_dir="${DEVNET_ROOT}/.runtime/deployments/${deployment_id}"
[[ -d "${deployment_dir}/revisions" && ! -L "${deployment_dir}" ]] ||
  devnet_die "deployment is missing: ${deployment_id}"
upgrade_lock="${deployment_dir}/.upgrade.lock"
mkdir "${upgrade_lock}" 2>/dev/null ||
  devnet_die "another upgrade is running for ${deployment_id}"
trap 'rmdir "${upgrade_lock}" 2>/dev/null || true' EXIT

active_selector="${DEVNET_ROOT}/.runtime/deployments/active.json"
[[ -f "${active_selector}" && ! -L "${active_selector}" ]] ||
  devnet_die "no active deployment is selected"
[[ "$(jq -r '.deploymentId' "${active_selector}")" == "${deployment_id}" ]] ||
  devnet_die "select ${deployment_id} before upgrading it"
active_revision="$(jq -r '.revision' "${DEVNET_ROOT}/.runtime/deployments/active.json")"
printf -v current_name '%03d.json' "${active_revision}"
current_manifest="${deployment_dir}/revisions/${current_name}"
next_revision="$((active_revision + 1))"
printf -v next_name '%03d.json' "${next_revision}"
next_manifest="${deployment_dir}/revisions/${next_name}"
target_json_path="${deployment_dir}/upgrade-target-${next_revision}.json"
plan_path="${deployment_dir}/upgrade-plan-${next_revision}.json"
native_manifest="${deployment_dir}/native/porep-market.json"

publish_active_revision() {
  local revision="$1" temporary
  temporary="${active_selector}.temporary.$$"
  jq -n --arg deploymentId "${deployment_id}" --argjson revision "${revision}" \
    '{schemaVersion:1,deploymentId:$deploymentId,revision:$revision}' >"${temporary}"
  mv "${temporary}" "${active_selector}"
}

if [[ -f "${next_manifest}" && ! -L "${next_manifest}" ]]; then
  devnet_verify_deployment_code "${next_manifest}"
  [[ -f "${target_json_path}" && ! -L "${target_json_path}" ]] ||
    devnet_die "completed revision is missing its upgrade target journal"
  target_root="$(jq -r '.snapshotPath' "${target_json_path}")"
  target_native_manifest="${target_root}/.deployment/devnet/harness-manifest.json"
  [[ -f "${target_native_manifest}" && ! -L "${target_native_manifest}" ]] ||
    devnet_die "completed revision is missing its native manifest"
  cp "${target_native_manifest}" "${native_manifest}"
  publish_active_revision "${next_revision}"
  rm -f "${plan_path}" "${target_json_path}"
  printf 'upgrade finalized after interrupted publication: %s revision=%s\n' \
    "${deployment_id}" "${next_revision}"
  exit 0
fi
[[ ! -e "${next_manifest}" && ! -L "${next_manifest}" ]] ||
  devnet_die "next deployment revision path is unsafe"

if [[ -f "${target_json_path}" && ! -L "${target_json_path}" ]]; then
  target_root="$(jq -r '.snapshotPath' "${target_json_path}")"
  target_was_prepared=false
else
  bash "${DEVNET_ROOT}/scripts/devnet-use-deployment.sh" "${deployment_id}" \
    "${active_revision}" >/dev/null
  timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  target_args=(contract-target prepare "${deployment_id}-upgrade-${next_revision}-${timestamp}")
  if [[ -n "${source_arg}" ]]; then target_args+=(--source "${source_arg}"); fi
  npm --silent --prefix "${DEVNET_ROOT}/tools" run cli -- "${target_args[@]}" \
    >"${target_json_path}.temporary"
  mv "${target_json_path}.temporary" "${target_json_path}"
  target_root="$(jq -r '.snapshotPath' "${target_json_path}")"
  target_was_prepared=true
fi
[[ -d "${target_root}" && ! -L "${target_root}" ]] ||
  devnet_die "upgrade target snapshot is unavailable"

[[ -f "${native_manifest}" && ! -L "${native_manifest}" ]] ||
  devnet_die "native PoRep Market deployment manifest is missing"
mkdir -p "${target_root}/.deployment/devnet"
target_native_manifest="${target_root}/.deployment/devnet/harness-manifest.json"
if [[ "${target_was_prepared}" == true || ! -f "${target_native_manifest}" ]]; then
  cp "${native_manifest}" "${target_native_manifest}"
fi
jq -e '.contracts.PoRepMarket.kind == "uups"
  and .contracts.Validator.kind == "implementation"
  and .contracts.ValidatorBeacon.kind == "beacon"' \
  "${target_native_manifest}" >/dev/null ||
  devnet_die "deployment predates the current manifest and must be redeployed, not upgraded"

IFS=',' read -r -a requested_contracts <<<"${contracts_csv}"
if [[ -f "${plan_path}" && ! -L "${plan_path}" ]]; then
  plan="$(<"${plan_path}")"
  [[ "$(jq -r '.steps | map(.contract) | join(",")' <<<"${plan}")" == "${contracts_csv}" ]] ||
    devnet_die "pending upgrade uses a different contract list"
else
  plan="$(
    npm --silent --prefix "${DEVNET_ROOT}/tools" run cli -- \
      upgrade plan "${deployment_id}" "${active_revision}" "${target_root}" \
      "${contracts_csv}" - <"${current_manifest}"
  )"
  printf '%s\n' "${plan}" >"${plan_path}.temporary"
  mv "${plan_path}.temporary" "${plan_path}"
fi

source_output="$(npm --prefix "${DEVNET_ROOT}/tools" run cli -- sources verify)"
curio_commit="$(awk -F '\t' '$1 == "curio" {print $3}' <<<"${source_output}")"
image="${DEVNET_IMAGE_NAMESPACE}/curio-all-in-one:${curio_commit:0:12}"
platform="$(jq -r '.platform' "${DEVNET_BUILD_DIR}/images.json")"
key_file="${DEVNET_DATA_DIR}/contracts/deployer.private-key"
[[ -f "${key_file}" && ! -L "${key_file}" ]] ||
  devnet_die "DevNet deployer key is unavailable"
deployer="$(jq -r '.identities.deployer' "${current_manifest}")"
rpc_url="http://lotus:1234/rpc/v1"

node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms 600000 -- \
  docker run --rm --platform "${platform}" \
  --entrypoint forge \
  -v "${target_root}:/workspace:rw" \
  -w /workspace \
  "${image}" build --build-info --extra-output storageLayout

cast_curio() {
  devnet_compose exec -T curio cast "$@" --rpc-url "${rpc_url}" | tr -d '\r'
}

live_implementation() {
  local contract_name="$1" address kind word
  address="$(jq -r --arg name "${contract_name}" '.contracts[$name].address' "${current_manifest}")"
  kind="$(jq -r --arg name "${contract_name}" '.contracts[$name].kind' "${current_manifest}")"
  if [[ "${kind}" == uups ]]; then
    word="$(cast_curio storage "${address}" \
      0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)"
    printf '0x%s\n' "${word: -40}"
  else
    cast_curio call "${address}" 'implementation()(address)' | awk '{print $1}'
  fi
}

expected_runtime_hash() {
  local operation_output="$1" code_hash
  code_hash="$(jq -r '.operations[0].newImplementationCodeHash' "${operation_output}")"
  [[ "${code_hash}" =~ ^0x[0-9a-fA-F]{64}$ ]] ||
    devnet_die "upstream runtime code hash is unavailable: ${contract_name}"
  printf '%s\n' "${code_hash}"
}

target_implementation() {
  local operation_output="$1"
  jq -r '.operations[0].newImplementation' "${operation_output}"
}

authorized_for_upgrade() {
  local contract_name="$1" address kind role owner manager pointer
  address="$(jq -r --arg name "${contract_name}" '.contracts[$name].address' "${current_manifest}")"
  kind="$(jq -r --arg name "${contract_name}" '.contracts[$name].kind' "${current_manifest}")"
  manager="$(jq -r '.contracts.AccessManager.address // empty' "${current_manifest}")"
  if [[ -n "${manager}" ]]; then
    if [[ "${kind}" == uups ]]; then
      pointer="$(cast_curio call "${address}" 'accessManager()(address)' | awk '{print $1}')"
    else
      pointer="$(cast_curio call "${address}" 'owner()(address)' | awk '{print $1}')"
    fi
    [[ "${pointer,,}" == "${manager,,}" ]] || return 1
    role="$(cast_curio call "${manager}" 'UPGRADER_ROLE()(bytes32)' | awk '{print $1}')"
    [[ "$(cast_curio call "${manager}" 'hasRole(bytes32,address)(bool)' "${role}" "${deployer}" | awk '{print $1}')" == true ]]
    return
  fi
  if [[ "${kind}" == uups ]]; then
    role="$(cast_curio call "${address}" 'UPGRADER_ROLE()(bytes32)' | awk '{print $1}')"
    [[ "$(cast_curio call "${address}" 'hasRole(bytes32,address)(bool)' "${role}" "${deployer}" | awk '{print $1}')" == true ]]
  else
    owner="$(cast_curio call "${address}" 'owner()(address)' | awk '{print $1}')"
    [[ "$(printf '%s' "${owner}" | tr '[:upper:]' '[:lower:]')" == \
      "$(printf '%s' "${deployer}" | tr '[:upper:]' '[:lower:]')" ]]
  fi
}

normalized_runtime_hash() {
  local artifact_path="$1" runtime="${2:-}" normalized
  if [[ -n "${runtime}" ]]; then
    normalized="$(node "${DEVNET_ROOT}/scripts/normalize-runtime-bytecode.mjs" \
      "${artifact_path}" "${runtime}")"
  else
    normalized="$(node "${DEVNET_ROOT}/scripts/normalize-runtime-bytecode.mjs" \
      "${artifact_path}")"
  fi
  cast keccak "${normalized}"
}

preflight_index=0
while IFS=$'\t' read -r contract_name kind calldata <&3; do
  preflight_index="$((preflight_index + 1))"
  expected="$(jq -r --arg name "${contract_name}" '.contracts[$name].implementation' "${current_manifest}")"
  actual="$(live_implementation "${contract_name}")"
  artifact="${contract_name}"
  [[ "${kind}" == validator-beacon ]] && artifact=Validator
  artifact_path="${target_root}/out/${artifact}.sol/${artifact}.json"
  [[ -f "${artifact_path}" ]] ||
    devnet_die "compiled target artifact is missing: ${artifact}"
  [[ "${calldata}" =~ ^0x([0-9a-fA-F]{2})*$ ]] ||
    devnet_die "upgrade calldata must be explicit hex: ${contract_name}"
  [[ "${calldata}" == 0x ]] ||
    devnet_die "non-empty upgrade calldata is unsupported by the pinned upgrade script: ${contract_name}"
  if [[ "$(printf '%s' "${expected}" | tr '[:upper:]' '[:lower:]')" == \
    "$(printf '%s' "${actual}" | tr '[:upper:]' '[:lower:]')" ]]; then
    current_runtime="$(cast_curio code "${actual}" | awk '{print $1}')"
    current_normalized_hash="$(normalized_runtime_hash "${artifact_path}" "${current_runtime}")"
    target_normalized_hash="$(normalized_runtime_hash "${artifact_path}")"
    [[ "$(printf '%s' "${target_normalized_hash}" | tr '[:upper:]' '[:lower:]')" != \
      "$(printf '%s' "${current_normalized_hash}" | tr '[:upper:]' '[:lower:]')" ]] ||
      devnet_die "requested target has unchanged implementation code: ${contract_name}"
    authorized_for_upgrade "${contract_name}" ||
      devnet_die "deployer lacks upgrade authority: ${contract_name}"
  else
    printf -v step_name '%02d-%s.json' "${preflight_index}" "${contract_name}"
    operation_output="${target_root}/.deployment/devnet/${step_name%.json}-operations.json"
    [[ -f "${operation_output}" && ! -L "${operation_output}" ]] ||
      devnet_die "live implementation is neither the old nor a recorded pending target: ${contract_name}"
    resumed_expected="$(target_implementation "${operation_output}")"
    [[ "$(printf '%s' "${resumed_expected}" | tr '[:upper:]' '[:lower:]')" == \
      "$(printf '%s' "${actual}" | tr '[:upper:]' '[:lower:]')" ]] ||
      devnet_die "live implementation is neither the old nor pending target: ${contract_name}"
  fi
done 3< <(jq -r '.steps[] | [.contract,.kind,.calldata] | @tsv' <<<"${plan}")

receipts_dir="${deployment_dir}/upgrade-receipts/${next_name%.json}"
mkdir -p "${receipts_dir}"
transactions_json="${receipts_dir}/transactions.json"
if [[ ! -f "${transactions_json}" ]]; then
  printf '[]\n' >"${transactions_json}"
fi
trap 'printf "upgrade stopped; resume the same target with: just upgrade %q source=%q contracts=%q\n" "${deployment_id}" "${source_arg}" "${contracts_csv}" >&2' ERR

step_index=0
while IFS=$'\t' read -r contract_name kind calldata <&3; do
  step_index="$((step_index + 1))"
  printf -v step_name '%02d-%s.json' "${step_index}" "${contract_name}"
  receipt_path="${receipts_dir}/${step_name}"
  log_path="${receipts_dir}/${step_name%.json}.log"
  operation_output="${target_root}/.deployment/devnet/${step_name%.json}-operations.json"
  operation_output_relative=".deployment/devnet/${step_name%.json}-operations.json"
  script_target="script/Upgrade.s.sol:Upgrade"
  broadcast_script="Upgrade.s.sol"
  artifact="${contract_name}"
  upstream_contract_name="${contract_name}"
  if [[ "${kind}" == validator-beacon ]]; then
    artifact=Validator
    upstream_contract_name=Validator
  fi

  old_impl="$(jq -r --arg name "${contract_name}" \
    '.contracts[$name].implementation' "${current_manifest}")"
  live_before="$(live_implementation "${contract_name}")"
  if [[ "$(printf '%s' "${live_before}" | tr '[:upper:]' '[:lower:]')" == \
    "$(printf '%s' "${old_impl}" | tr '[:upper:]' '[:lower:]')" ]]; then
    jq -n '{operations:[]}' >"${operation_output}"
    node "${DEVNET_ROOT}/scripts/run-with-timeout.mjs" --timeout-ms 900000 -- \
      docker run --rm --network "${DEVNET_PROJECT}_default" \
      --platform "${platform}" \
      --entrypoint bash \
      -e "RPC_URL=${rpc_url}" \
      -e "DEPLOYMENT_MANIFEST=.deployment/devnet/harness-manifest.json" \
      -e "UPGRADE_CONTRACT_NAMES=${upstream_contract_name}" \
      -e "UPGRADE_OUTPUT=${operation_output_relative}" \
      -v "${target_root}:/workspace:rw" \
      -v "${DEVNET_ROOT}/scripts/filecoin-rpc-proxy.mjs:/run/filecoin-rpc-proxy.mjs:ro" \
      -v "${key_file}:/run/secrets/deployer-key:ro" \
    -w /workspace \
    "${image}" -ec \
    'printf -v PRIVATE_KEY "%s" "$(cat /run/secrets/deployer-key)"; export PRIVATE_KEY
     FILECOIN_RPC_UPSTREAM="$RPC_URL" FILECOIN_RPC_PROXY_PORT=1235 node /run/filecoin-rpc-proxy.mjs &
     proxy_pid="$!"; trap '\''kill "${proxy_pid}" 2>/dev/null || true'\'' EXIT
     for attempt in $(seq 1 20); do
       curl -fsS -X POST -H "content-type: application/json" --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_chainId\",\"params\":[]}" http://127.0.0.1:1235 >/dev/null 2>&1 && break
       sleep 0.1
     done
     kill -0 "${proxy_pid}"
     forge script "$1" --rpc-url http://127.0.0.1:1235 \
       --gas-estimate-multiplier 100000 --disable-block-gas-limit \
       --broadcast --slow --private-key "$PRIVATE_KEY"' \
      upgrade "${script_target}" >"${log_path}" 2>&1
  fi

  expected_impl="$(target_implementation "${operation_output}")"
  new_impl="$(live_implementation "${contract_name}")"
  [[ "$(printf '%s' "${new_impl}" | tr '[:upper:]' '[:lower:]')" == \
    "$(printf '%s' "${expected_impl}" | tr '[:upper:]' '[:lower:]')" ]] ||
    devnet_die "live implementation does not match the requested target: ${contract_name}"
  [[ "$(printf '%s' "${new_impl}" | tr '[:upper:]' '[:lower:]')" != \
    "$(printf '%s' "${old_impl}" | tr '[:upper:]' '[:lower:]')" ]] ||
    devnet_die "upgrade did not change implementation: ${contract_name}"

  expected_hash="$(expected_runtime_hash "${operation_output}")"
  code_hash="$(cast keccak "$(cast_curio code "${new_impl}" | awk '{print $1}')")"
  [[ "$(printf '%s' "${code_hash}" | tr '[:upper:]' '[:lower:]')" == \
    "$(printf '%s' "${expected_hash}" | tr '[:upper:]' '[:lower:]')" ]] ||
    devnet_die "live implementation code does not match the compiled target: ${contract_name}"

  if [[ "${kind}" == validator-beacon ]]; then
    jq --arg implementation "${new_impl}" --arg implementationCodeHash "${code_hash}" \
      '.contracts.Validator.implementation=$implementation
       | .contracts.Validator.implementationCodeHash=$implementationCodeHash
       | .contracts.ValidatorBeacon.implementation=$implementation' \
      "${target_native_manifest}" >"${target_native_manifest}.temporary"
  else
    jq --arg name "${contract_name}" --arg implementation "${new_impl}" \
      --arg implementationCodeHash "${code_hash}" \
      '.contracts[$name].implementation=$implementation
       | .contracts[$name].implementationCodeHash=$implementationCodeHash' \
      "${target_native_manifest}" >"${target_native_manifest}.temporary"
  fi
  mv "${target_native_manifest}.temporary" "${target_native_manifest}"

  if [[ -f "${receipt_path}" && ! -L "${receipt_path}" ]]; then
    tx_hash="$(jq -r '.hash' "${receipt_path}")"
    block_number="$(jq -r '.blockNumber' "${receipt_path}")"
  else
    chain_id="$(cast_curio chain-id | awk '{print $1}')"
    broadcast="${target_root}/broadcast/${broadcast_script}/${chain_id}/run-latest.json"
    proxy="$(jq -r --arg name "${contract_name}" \
      '.contracts[$name].address | ascii_downcase' "${current_manifest}")"
    transaction_target="${proxy}"
    expected_input=""
    manager="$(jq -r '.contracts.AccessManager.address // empty' "${current_manifest}")"
    if [[ "${kind}" == validator-beacon && -n "${manager}" ]]; then
      transaction_target="${manager,,}"
      expected_input="$(cast calldata 'upgradeBeacon(address,address)' "${proxy}" "${actual}")"
    fi
    tx_matches="$(
      jq -c --arg proxy "${transaction_target}" --arg expectedInput "${expected_input,,}" \
        '[.transactions[]
          | select(.transactionType == "CALL")
          | select((.transaction.to // "" | ascii_downcase) == $proxy)
          | select($expectedInput == "" or
              ((.transaction.input // .transaction.data // "" | ascii_downcase) == $expectedInput))
          | .hash] | unique' "${broadcast}"
    )"
    [[ "$(jq 'length' <<<"${tx_matches}")" == 1 ]] ||
      devnet_die "expected one upgrade call transaction: ${contract_name}"
    tx_hash="$(jq -r '.[0]' <<<"${tx_matches}")"
    [[ "${tx_hash}" =~ ^0x[0-9a-fA-F]{64}$ ]] ||
      devnet_die "upgrade transaction hash is missing: ${contract_name}"
    receipt_json="$(cast_curio receipt "${tx_hash}" --json)"
    [[ "$(jq -r '.status' <<<"${receipt_json}")" == 0x1 ]] ||
      devnet_die "upgrade transaction failed: ${contract_name}"
    block_hex="$(jq -r '.blockNumber' <<<"${receipt_json}")"
    block_number="$((block_hex))"
  fi

  jq -n \
    --arg contract "${contract_name}" \
    --arg kind "${kind}" \
    --arg hash "${tx_hash}" \
    --arg implementation "${new_impl}" \
    --arg implementationCodeHash "${code_hash}" \
    --argjson blockNumber "${block_number}" \
    '{contract:$contract,kind:$kind,hash:$hash,blockNumber:$blockNumber,
      implementation:$implementation,implementationCodeHash:$implementationCodeHash}' \
    >"${receipt_path}.temporary"
  mv "${receipt_path}.temporary" "${receipt_path}"
  jq --slurpfile receipt "${receipt_path}" \
    'if any(.[]; .hash == $receipt[0].hash) then .
     else . + [{purpose:("upgrade:" + $receipt[0].contract),hash:$receipt[0].hash,blockNumber:$receipt[0].blockNumber}]
     end' "${transactions_json}" >"${transactions_json}.temporary"
  mv "${transactions_json}.temporary" "${transactions_json}"
done 3< <(jq -r '.steps[] | [.contract,.kind,.calldata] | @tsv' <<<"${plan}")

epoch="$(cast_curio block-number | awk '{print $1}')"
jq \
  --argjson revision "${next_revision}" \
  --argjson parentRevision "${active_revision}" \
  --arg generatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson epoch "${epoch}" \
  --slurpfile target "${target_json_path}" \
  --slurpfile transactions "${transactions_json}" \
  '.revision=$revision
   | .parentRevision=$parentRevision
   | .generatedAt=$generatedAt
   | .chain.epoch=$epoch
   | .target=$target[0]
   | .transactions=$transactions[0]' \
  "${current_manifest}" >"${next_manifest}.temporary"

for receipt in "${receipts_dir}"/[0-9][0-9]-*.json; do
  contract_name="$(jq -r '.contract' "${receipt}")"
  implementation="$(jq -r '.implementation' "${receipt}")"
  implementation_hash="$(jq -r '.implementationCodeHash' "${receipt}")"
  implementation_entry="${contract_name}Implementation"
  [[ "${contract_name}" == ValidatorBeacon ]] && implementation_entry=ValidatorImplementation
  jq \
    --arg contract "${contract_name}" \
    --arg implementationEntry "${implementation_entry}" \
    --arg implementation "${implementation}" \
    --arg implementationCodeHash "${implementation_hash}" \
    '.contracts[$contract].implementation=$implementation
     | .contracts[$contract].implementationCodeHash=$implementationCodeHash
     | if .contracts[$implementationEntry] then
         .contracts[$implementationEntry].address=$implementation
         | .contracts[$implementationEntry].runtimeCodeHash=$implementationCodeHash
       else . end' \
    "${next_manifest}.temporary" >"${next_manifest}.updating"
  mv "${next_manifest}.updating" "${next_manifest}.temporary"
done

devnet_verify_deployment_code "${next_manifest}.temporary"
mv "${next_manifest}.temporary" "${next_manifest}"
cp "${target_native_manifest}" "${native_manifest}"
publish_active_revision "${next_revision}"
rm -f "${plan_path}" "${target_json_path}"
trap - ERR
printf 'upgrade complete: %s revision=%s\n' "${deployment_id}" "${next_revision}"
