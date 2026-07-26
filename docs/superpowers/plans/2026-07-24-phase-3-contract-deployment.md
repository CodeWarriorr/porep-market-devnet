# Phase 3 Contract Deployment Implementation Plan

> **Execution:** Implement inline in the main thread with TDD. Do not use
> subagents unless the goal's Lean Execution Mode exception is met.

**Goal:** Deploy and validate the complete PoRep Market test ecosystem on the
current Curio DevNet and publish one generation-bound manifest.

**Architecture:** Reuse the pinned repositories' Foundry builds and PoRep
`Deploy.s.sol`. Keep orchestration in one direct shell entrypoint and keep
manifest parsing/validation in small typed TypeScript functions. Harness-only
contracts live in this repository; generated artifacts and addresses live only
under `.runtime/`.

**Tech Stack:** Bash, `just`, Foundry/cast from the pinned DevNet image,
TypeScript/Node 20, Lotus JSON-RPC/CLI, and JSON manifests.

## Global constraints

- Use only the nine managed exact source checkouts and the current project
  Compose services.
- Never modify a managed checkout; Foundry outputs go to ignored runtime paths.
- Do not print private keys. Manifests contain public addresses only.
- Bind every manifest to chain ID `31415926`, current genesis CID, runtime
  generation, provider ID, source commits, and deployed bytecode.
- `just deploy` is bounded and may reuse only a manifest that validates against
  the current chain. `just addresses` is read-only.
- Keep the implementation direct. No deployment framework, plugin system,
  generalized schema engine, or speculative security fixtures.
- Git writes and commits remain forbidden in this repository.

---

## Task 1: Typed deployment manifest

**Files:**

- Create: `tools/src/deployment.ts`
- Create: `tools/test/deployment.test.ts`
- Modify: `tools/src/cli.ts`

**Produces:**

- `parseDeploymentManifest(text): DeploymentManifest`
- `assertDeploymentMatchesRuntime(manifest, status, lock): void`
- CLI commands `deployment inspect` and `deployment addresses`

- [x] Write tests for a minimal valid schema containing `schemaVersion`,
  `generatedAt`, `generation`, `genesisCid`, `chainId`, `epoch`, `provider`,
  exact source commits, public identities, and named contract
  address/implementation/code-hash records.
- [x] Write rejection tests for malformed addresses/hashes, missing required
  contracts, wrong chain ID, stale generation/genesis/provider, and source-ref
  mismatch.
- [x] Run
  `npm --prefix tools test -- --test-name-pattern='deployment manifest'` and
  record the expected missing-module RED.
- [x] Implement only the typed parser, runtime comparison, and public-address
  formatter needed by those tests.
- [x] Run focused tests and `npm --prefix tools run typecheck`.

## Task 2: Harness contracts and reproducible build

**Files:**

- Create: `contracts/foundry.toml`
- Create: `contracts/src/MockUSDC.sol`
- Create: `contracts/src/NotificationReceiver.sol`
- Create: `contracts/src/FailingNotificationReceiver.sol`
- Create: `contracts/test/HarnessContracts.t.sol`
- Create: `scripts/contracts-build.sh`
- Modify: `tools/test/deployment.test.ts`, `.gitignore`, `justfile`

**Produces:**

- six-decimal test USDC with the authorization behavior required by
  FilecoinPay;
- one state-recording notification receiver and one deliberate failure
  receiver; use the pinned PoRep `PoRepMarketSectorStatusInspector` for
  FIP-0112 instead of duplicating it;
- build artifacts under `.runtime/contracts/out/`

- [x] Add static failing tests that require the three named harness contracts,
  the pinned PoRep sector inspector, exact
  compiler version, runtime-only output path, and a bounded Foundry invocation.
- [x] Add Foundry tests for USDC decimals/mint/authorization, notification
  record/idempotency and deliberate receiver failure.
- [x] Run the focused Node test for RED.
- [x] Add the smallest contracts and build script, importing pinned libraries
  from managed source paths without copying production contracts.
- [x] Run the bounded contract build and Foundry tests in the project image,
  then rerun the focused Node tests.

## Task 3: Direct deployment and configuration

**Files:**

- Create: `scripts/devnet-deploy.sh`
- Create: `scripts/devnet-addresses.sh`
- Modify: `scripts/devnet-common.sh`
- Modify: `tools/test/deployment.test.ts`
- Modify: `justfile`, `README.md`

**Produces:**

- `just deploy`
- `just addresses`
- `.runtime/deployments/latest.json`

- [x] Add failing script-contract tests requiring: `just status` preflight;
  current generation/genesis capture; distinct public identities; bounded
  Foundry/cast calls; deployment of MockUSDC, FilecoinPay, MetaAllocator,
  PoRep Market, DataCapEvidenceAdapter, Validator implementation/beacon/factory,
  SPRegistry, SLIOracle, SLIScorer, termination oracle, and the notification/
  sector helpers; role/funding/allowance setup; bytecode checks; and atomic
  manifest publication.
- [x] Run focused tests and record RED on missing deploy scripts.
- [x] Implement one readable orchestration script using the pinned
  `FilecoinPayV1`, `Allocator`/`Factory`, and PoRep `Deploy.s.sol` paths.
  Keep command wrappers and manifest assembly local to this script.
- [x] Configure only the roles, balances, provider, operator, adapter
  allowance, and SLI identities required by the existing scenarios.
- [x] Make `just addresses` validate the manifest first and print only public
  names, addresses, chain/generation, and source refs.
- [x] Run focused tests, typecheck, shell syntax, and `just test-unit`.

## Task 4: Live deployment, stale-state proof, and Phase 3 gate

**Files:**

- Modify: `README.md`
- Modify: `docs/goals/2026-07-24-complete-porep-market-curio-devnet.md`
- Modify: `.superpowers/sdd/progress.md`
- Runtime: `.runtime/deployments/`, `.runtime/devnet/logs/`

- [x] Run `just status && just deploy && just addresses`.
- [x] Verify bytecode/code hashes and every configured role, balance,
  allowance, provider, offer, adapter, validator, rail, and SLI prerequisite
  named by the Phase 3 goal checklist.
- [x] Run `just deploy` again. Accept only validated idempotent reuse or a
  precise fail-safe refusal.
- [x] Save current manifest evidence, run one project-only reset, and prove the
  old manifest is rejected before any new transaction.
- [x] Run `just up && just status && just deploy` and prove a new
  generation-bound manifest is created.
- [x] Run one focused main-thread Phase 3 review of deployment correctness and
  stale-manifest behavior, fix concrete findings with regressions, and rerun
  affected live checks.
- [x] Run `just test-unit`, source verification, shell syntax, and
  `git diff --check`; then update the goal checklist and ledger.

## Completion gate

Phase 3 closes only when the complete contract list has live bytecode, required
configuration reads back correctly, `just addresses` validates current state,
an idempotent second deploy is safe, a reset rejects the old manifest, and the
same direct workflow creates a valid manifest on the new chain.
