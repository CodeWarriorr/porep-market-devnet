# PoRep Market DevNet Simplification and Upgrade Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Curio DevNet a fast, reliable PoRep Market development harness that can test pinned releases, local branches, dirty audit patches, repeated fresh deployments, and in-place upgrades without recreating the blockchain unless a fresh-chain qualification run is explicitly requested.

**Architecture:** Keep one pinned, long-lived Curio/Lotus chain lifecycle and give PoRep Market sources, deployments, revisions, and scenario runs separate identities. Reliability comes from recording the selected source, checking live proxy/beacon implementations and required wiring, and asserting scenario-specific state deltas. The harness remains direct: one static scenario registry, one deployment record format, explicit lifecycle commands, and no plugin framework.

**Tech Stack:** Bash, `just`, TypeScript/Node.js, Foundry/Forge/Cast, Docker Compose, Curio, Lotus, JSON runtime records.

## Global Constraints

- PoRep Market testing is priority one. ZigZag is not part of this implementation plan.
- `just up` and `just down` preserve the current chain.
- `just reset` is the only destructive chain command and must retain the existing project/path ownership protections.
- `just deploy` creates a new contract graph on the current chain. It must not reset the chain and must not silently reuse another graph.
- A scenario run is repeatable, not state-neutral: it may create new deals, offers, allocations, sectors, and payment rails, but it must not require an empty chain or fixed next IDs.
- A scenario must assert a baseline/delta or use IDs emitted by its own transactions.
- The default source remains the clean commit in `versions.lock.yaml`; an explicit absolute local checkout is also supported and may be dirty.
- Dirty local sources are allowed for development but are reported as dirty. Release qualification requires the locked clean source.
- The harness records deployed bytecode and source identity; it does not implement its own Solidity storage-layout validator or replace the PoRep Market repository's audit and canonical test tooling.
- Manifest contract maps accept additional contracts. Each scenario declares the logical contracts it requires.
- No dynamic scenario discovery, generic plugin system, generic chaos framework, automatic PR discovery, or automatic multi-contract upgrade inference.
- Do not stage, commit, push, rebase, or perform GitHub writes in this repository.

---

## Target file structure

- `tools/src/contract-target.ts`: resolve the default locked source or one explicit local source and create an immutable build snapshot.
- `tools/test/contract-target.test.ts`: source-mode, dirty-state, path, and snapshot identity tests.
- `tools/src/deployment.ts`: schema-v2 deployment/revision parsing and live runtime identity checks.
- `tools/test/deployment.test.ts`: deployment history, active selector, proxy metadata, and flexible contract-map tests.
- `scripts/contracts-prepare-target.sh`: copy the selected market checkout into a deployment-specific work directory.
- `scripts/devnet-deploy.sh`: always create a fresh contract graph on the current chain.
- `scripts/devnet-upgrade.sh`: run explicit upstream UUPS or Validator beacon upgrades and publish a new revision.
- `scripts/devnet-use-deployment.sh`: select one existing deployment revision for scenarios.
- `scripts/devnet-reset.sh`: erase project chain state without automatically archiving gigabytes.
- `e2e/src/config.ts`: load an explicit deployment revision rather than a global `latest.json`.
- `e2e/src/scenarios/registry.ts`: static metadata for tags, timeout, required contracts, and fixture requirements.
- `e2e/src/runtime.ts`: own run ID, timeout, success/failure summary, and deployment revision binding.
- `e2e/src/matrix.ts`: select scenarios by suite/tag and consume summaries directly.
- `e2e/src/fixtures/activeSector.ts`: reuse or create a generation-bound active-sector fixture.
- `e2e/src/scenarios/sectorStatus.ts`: use its own fixture instead of the last receiver call.
- `e2e/src/scenarios/upgradeContinuity.ts`: populate state, cross an upgrade, and continue the same objects.
- `README.md` and `docs/runtime/curio-devnet.md`: document the development, fresh qualification, and upgrade workflows.

---

### Task 1: Replace locked-only market input with an explicit contract target

**Files:**
- Create: `tools/src/contract-target.ts`
- Create: `tools/test/contract-target.test.ts`
- Modify: `tools/src/cli.ts`
- Create: `scripts/contracts-prepare-target.sh`
- Modify: `scripts/devnet-deploy.sh`

**Interfaces:**
- Consumes: the default `sources.porep_market` entry from `versions.lock.yaml`, or `--source /absolute/path`.
- Produces:

```ts
export type ContractTarget = {
  mode: "locked" | "local";
  sourcePath: string;
  snapshotPath: string;
  commit: string;
  dirty: boolean;
  submodules: Record<string, string>;
};

export async function prepareContractTarget(input: {
  projectRoot: string;
  sourcePath?: string;
  deploymentSeed: string;
}): Promise<ContractTarget>;
```

- [ ] **Step 1: Write failing tests for the two supported source modes**

Test that no `sourcePath` resolves the exact locked checkout. Test that an explicit relative path is rejected, an absolute clean checkout is accepted, and an absolute dirty checkout is accepted with `dirty: true`.

Run:

```bash
node scripts/run-with-timeout.mjs --timeout-ms 60000 -- \
  npm --prefix tools test -- --test-name-pattern="contract target"
```

Expected: FAIL because `contract-target.ts` and the CLI command do not exist.

- [ ] **Step 2: Implement one deterministic snapshot operation**

Copy the checkout to `.runtime/contracts/targets/<deployment-seed>/porep-market/`. Exclude `.git`, `out`, `cache`, `broadcast`, and `deployments/*/upgrades`. Record the source `HEAD`, dirty flag, and recursive submodule HEADs. Do not add a second full-tree hashing pass: the immutable snapshot plus compiled/deployed bytecode hashes are enough for local dirty-source evidence, while clean qualification uses the commit and submodule commits.

The copied snapshot, not the mutable local checkout, is the Foundry build root for the deployment.

- [ ] **Step 3: Add `contract-target prepare` to `tools/src/cli.ts`**

The command prints exactly one JSON object matching `ContractTarget`. It accepts only `--source <absolute-path>`; no implicit sibling checkout or PR discovery.

- [ ] **Step 4: Make deployment consume the prepared snapshot**

Remove the fixed `.runtime/contracts/work/porep-market` destination and the copy-only-if-missing behavior from `scripts/devnet-deploy.sh`. Pass the deployment-specific snapshot path to the container.

- [ ] **Step 5: Verify both modes**

Run the focused tests, then prepare the locked target twice and assert identical commit and submodule identities. Prepare an explicit dirty fixture and assert the command succeeds while reporting `"dirty":true`.

---

### Task 2: Replace the single deployment manifest with append-only deployments and revisions

**Files:**
- Modify: `tools/src/deployment.ts`
- Modify: `tools/src/cli.ts`
- Modify: `tools/test/deployment.test.ts`
- Modify: `scripts/contracts-deploy-in-container.sh`
- Modify: `scripts/devnet-deploy.sh`
- Create: `scripts/devnet-use-deployment.sh`
- Modify: `scripts/devnet-addresses.sh`
- Modify: `justfile`

**Interfaces:**
- Produces:

```ts
export type DeploymentContract = {
  address: string;
  runtimeCodeHash: string;
  kind: "direct" | "uups" | "beacon";
  implementation?: string;
  implementationCodeHash?: string;
};

export type DeploymentRevision = {
  schemaVersion: 2;
  deploymentId: string;
  revision: number;
  parentRevision: number | null;
  generatedAt: string;
  chain: {
    generation: string;
    genesisCid: string;
    chainId: number;
    provider: string;
    epoch: number;
  };
  target: ContractTarget;
  identities: Record<string, string>;
  contracts: Record<string, DeploymentContract>;
  transactions: Array<{ purpose: string; hash: string; blockNumber: number }>;
};

export type ActiveDeployment = {
  schemaVersion: 1;
  deploymentId: string;
  revision: number;
};
```

- Runtime layout:

```text
.runtime/deployments/
  active.json
  <deployment-id>/
    identities.private.json
    deploy.log
    native/porep-market.json
    revisions/000.json
```

- [ ] **Step 1: Write failing schema-v2 tests**

Cover arbitrary additional contract names, missing scenario-required names, malformed addresses/hashes, wrong chain identity, and revision-parent mismatch. Remove tests that require exactly 22 contract names.

- [ ] **Step 2: Add proxy-aware records**

For UUPS entries, read the ERC-1967 implementation slot and record the current implementation address and code hash. For `ValidatorBeacon`, record the beacon address and its current implementation. Direct contracts retain only their own runtime code hash.

- [ ] **Step 3: Make `just deploy source=''` always create a new graph**

Generate a deployment ID before target preparation:

```text
deployment-<UTC compact timestamp>-<first 12 characters of source commit>
```

Refuse an existing directory with the same ID. Do not inspect `active.json` to decide whether deployment is a no-op. Do not call `reset`.

- [ ] **Step 4: Persist the upstream native deployment artifact**

Copy the PoRep source's `deployments/devnet/latest.json` to `<deployment-id>/native/porep-market.json`. Later upgrades must use this artifact instead of trying to reconstruct the upstream format from the harness record.

- [ ] **Step 5: Publish the revision and active selector atomically**

Write temporary regular files, validate revision `000.json`, verify live code/proxy/beacon state, then rename the revision and finally `active.json`.

- [ ] **Step 6: Add explicit selection**

Expose:

```text
just use-deployment <deployment-id> revision='latest'
just addresses deployment='active'
```

`use-deployment` validates chain identity and live implementation pointers before changing `active.json`.

- [ ] **Step 7: Verify two deployments on one chain**

Start from an already-running DevNet, deploy the same target twice, and assert:

- generation and genesis CID are unchanged;
- deployment IDs and proxy addresses differ;
- both revision records remain readable;
- selecting either graph makes `just addresses` report that graph.

---

### Task 3: Bind every scenario run to one deployment revision and centralize result publication

**Files:**
- Modify: `e2e/src/config.ts`
- Modify: `e2e/src/runtime.ts`
- Modify: `e2e/src/cli.ts`
- Modify: `e2e/src/matrix.ts`
- Modify: `e2e/test/config.test.ts`
- Modify: `e2e/test/runtime.test.ts`
- Modify: all files under `e2e/src/scenarios/` that call `writeRunSummary`

**Interfaces:**
- `loadConfig()` resolves `E2E_DEPLOYMENT_ID` and `E2E_DEPLOYMENT_REVISION`, defaulting to `.runtime/deployments/active.json`.
- `ScenarioContext` contains:

```ts
runId: string;
deploymentId: string;
deploymentRevision: number;
```

- The CLI, not individual scenarios, writes `summary.json` in a `finally` block with `result: "passed" | "failed"`, deployment identity, completed steps, state IDs, and the error message.

- [ ] **Step 1: Write failing configuration tests**

Test active selection, explicit historical selection, stale generation rejection, missing revision rejection, and a revision whose proxy implementation no longer matches live state.

- [ ] **Step 2: Resolve one immutable revision at run start**

Once loaded, the scenario never follows later changes to `active.json`. Record the revision path and target metadata in the run summary.

- [ ] **Step 3: Centralize summaries**

Remove every scenario-level `writeRunSummary(context)` call. Make the CLI publish a summary on preflight failure, scenario failure, timeout, and success.

- [ ] **Step 4: Stop scraping stdout for summary paths**

Pass `SCENARIO_RUN_DIR` from the matrix child process and read `<run-dir>/summary.json` directly. A failed scenario must have a non-null summary path.

- [ ] **Step 5: Verify failure evidence**

Run one unit fixture that throws in step two and assert the summary contains the first successful step, the failed step artifact, deployment revision, and exact error.

---

### Task 4: Add small static scenario metadata and per-scenario timeouts

**Files:**
- Modify: `e2e/src/scenarios/registry.ts`
- Modify: `e2e/src/matrix.ts`
- Modify: `e2e/test/scenario-registry.test.ts`
- Delete source-shape assertions from: `e2e/test/scenario-guard.test.ts`
- Modify: `justfile`

**Interfaces:**

```ts
export type ScenarioDefinition = {
  run: (context: ScenarioContext) => Promise<void>;
  tags: Array<"contract" | "curio" | "sealing" | "upgrade" | "security">;
  timeoutMs: number;
  requiredContracts: string[];
  fixtures?: Array<"active-sector">;
};
```

- [ ] **Step 1: Write failing registry behavior tests**

Require a positive timeout, at least one tag, no duplicate required contract, and resolvable suite names. Test behavior through exported metadata rather than regex-reading implementation source.

- [ ] **Step 2: Define four suites**

```text
contract   on-chain market flows that do not wait for Curio sealing
curio      notification and sector flows
security   access-control, rejection, stale/termination, and replay cases
full       every registered scenario
```

`upgrade` remains a stateful workflow, not part of ordinary alphabetical matrix execution.

- [ ] **Step 3: Enforce each scenario's own timeout**

Terminate only the scenario child, publish its failure summary, collect bounded diagnostics, and continue or stop according to `--fail-fast`.

- [ ] **Step 4: Add simple commands**

```text
just test-scenario <name> deployment='active'
just test-e2e suite='contract' deployment='active'
just test-e2e suite='full' deployment='active'
```

- [ ] **Step 5: Remove source-regex implementation policing**

Keep only regression checks that cannot be expressed behaviorally, such as no Boost executable invocation and no secret-bearing `.env` requirement.

---

### Task 5: Make slow sector scenarios standalone and repeated-run safe

**Files:**
- Create: `e2e/src/fixtures/activeSector.ts`
- Create: `e2e/test/active-sector-fixture.test.ts`
- Modify: `e2e/src/scenarios/directOnboardingNotification.ts`
- Modify: `e2e/src/scenarios/sectorStatus.ts`
- Modify: `e2e/src/flows/provider.ts`
- Modify: `e2e/src/devnet/piece.ts`

**Interfaces:**

```ts
export type ActiveSectorFixture = {
  generation: string;
  provider: string;
  sector: number;
  deadline: number;
  partition: number;
  pieceCid: string;
  createdByRunId: string;
};

export async function ensureActiveSectorFixture(
  context: ScenarioContext,
): Promise<ActiveSectorFixture>;
```

- [ ] **Step 1: Write failing fixture tests**

Test reuse when the recorded sector is still active, recreation when it is missing/faulty/dead, generation mismatch rejection, and concurrent creation lock behavior.

- [ ] **Step 2: Store the fixture by chain generation**

Use `.runtime/fixtures/<generation>/active-sector.json`. Before reuse, query Lotus sector partition/status and confirm provider and generation. Never infer the fixture from `NotificationReceiver.lastSector()`.

- [ ] **Step 3: Make sector-status scenarios call `ensureActiveSectorFixture`**

Both active and unknown-sector tests become independently runnable in any order. The first run may seal; later runs reuse the valid sector.

- [ ] **Step 4: Stop overwriting provider state to a fixed test value**

Read current provider/offer state. Reuse a matching active offer, and increase capacity only when the scenario's required bytes exceed current available bytes. Assert the delta caused by the current scenario instead of assuming a zero baseline.

- [ ] **Step 5: Replace PID-based piece paths with `runId`**

Every generated CAR/piece directory is unique across long-lived processes and retained runs.

- [ ] **Step 6: Prove repeatability**

On one deployment and one chain, run:

```bash
just test-e2e suite=contract
just test-e2e suite=contract
just test-scenario sector-status-active
just test-scenario sector-status-active
```

All four commands must pass without reset, and the second sector-status run must reuse the validated fixture.

---

### Task 6: Simplify normal verification without removing the boundaries that catch real failures

**Files:**
- Modify: `tools/src/runtime-lock.ts`
- Modify: `tools/src/devnet.ts`
- Modify: `tools/test/runtime-lock.test.ts`
- Modify: `tools/test/devnet.test.ts`
- Modify: `scripts/devnet-up.sh`
- Modify: `scripts/devnet-common.sh`
- Modify: `README.md`

**Interfaces:**
- Normal `just up` checks:
  - project-scoped paths and ports;
  - required services exist;
  - no host-wide or unsafe mounts;
  - Curio/Lotus images exist;
  - services reach readiness;
  - live Curio/Lotus versions, chain ID, network/actor version, provider, and sector size match the stock lock.
- `just verify-runtime` records exact source/image/runtime identities for qualification.

- [ ] **Step 1: Replace exact rendered-Compose tests with safety/readiness tests**

Delete assertions for exact service ordering, exact logging configuration, exact healthcheck command arrays, empty `ipam`, and the exact complete mount list. Retain project name, required services, loopback port uniqueness, mount confinement, and absence of `container_name`/static IPs/anonymous volumes.

- [ ] **Step 2: Remove duplicated constants from `runtime-lock.ts`**

Validate types and relations from `versions.lock.yaml`. Do not duplicate the chain ID, actor CIDs, BLST ref, service list, ports, or exact network schedule as second authorities in TypeScript.

- [ ] **Step 3: Keep live semantic readiness strict**

Do not weaken the current checks for actual Lotus/Curio commit, NV/actor state, provider, sector size, Curio APIs, Market endpoint, or database readiness.

- [ ] **Step 4: Simplify source verification**

For managed locked sources, retain HTTPS repository validation, exact HEAD, clean state, exact recursive submodule HEADs, sanitized Git environment, and cache path confinement. Remove the exhaustive allowlist model for harmless local Git configuration keys.

- [ ] **Step 5: Verify normal and qualification modes**

Run focused tooling tests. Change one harmless Compose logging option and confirm normal inspection still passes. Change a host mount outside the project and confirm it fails. Change a live version fixture and confirm readiness fails.

---

### Task 7: Make reset disposable and make a fresh-chain run explicit

**Files:**
- Modify: `scripts/devnet-reset.sh`
- Modify: `scripts/devnet-common.sh`
- Modify: `justfile`
- Modify: `README.md`
- Modify: `docs/runtime/curio-devnet.md`
- Modify: `tools/test/devnet.test.ts`

**Interfaces:**

```text
just down                    preserve chain and deployment state
just up                      reuse preserved state
just reset                   delete this project's active chain state and start a new generation
just test-all                no reset; tests selected target/deployment on the current chain
just test-fresh source=''    explicit reset, deploy, and full matrix
```

- [ ] **Step 1: Write failing reset-retention tests**

Assert reset captures only bounded final logs and small JSON identities, then deletes the owned data tree. Assert it does not move the data tree into `verification-backups`.

- [ ] **Step 2: Remove automatic full-state archives**

Keep the safe path, owner marker, exact Compose project, and volume-removal checks. Preserve `.runtime/runs` and public deployment history; clear active selection, private identities for the erased chain, fixtures, status, and generation.

- [ ] **Step 3: Remove reset from ordinary `test-all`**

`test-all` runs tooling tests, the selected PoRep Market canonical Forge suite, deploys or uses an explicit graph, and runs the requested live suite on the current chain.

- [ ] **Step 4: Add explicit `test-fresh`**

This is the release/qualification lane. It resets, creates a new graph from the locked clean target, runs `contract`, `curio`, and `security` suites, and records exact runtime/source identities.

- [ ] **Step 5: Verify disk behavior**

Run reset against a disposable fixture tree and assert no full data copy remains under `.runtime/verification-backups`. Do not run a live destructive reset without explicit execution approval.

---

### Task 8: Run the selected PoRep Market's canonical tests before expensive live scenarios

**Files:**
- Create: `scripts/contracts-test-target.sh`
- Modify: `justfile`
- Modify: `README.md`
- Modify: `scripts/static-checks.sh`

**Interfaces:**

```text
just test-contracts source=''
```

- [ ] **Step 1: Add a failing command-surface test**

Require `test-contracts` and prove it prepares the same target format used by deployment.

- [ ] **Step 2: Run canonical Foundry tests inside the pinned Foundry image**

Run `forge test` at the selected PoRep Market snapshot root, not only the six small harness fixture tests under `/contracts`.

- [ ] **Step 3: Keep fuzz/property/security ownership upstream**

Do not duplicate hundreds of Solidity tests in the TypeScript harness. Audit patches and new contract PRs add their unit, fuzz, invariant, and upgrade-layout tests to the selected PoRep Market checkout; this command runs them unchanged.

- [ ] **Step 4: Put the fast failure first**

`test-all` and `test-fresh` run `test-contracts` before contract deployment or Curio sealing.

---

### Task 9: Add explicit, recorded multi-contract upgrade support

**Files:**
- Create: `scripts/devnet-upgrade.sh`
- Create: `tools/src/upgrade.ts`
- Create: `tools/test/upgrade.test.ts`
- Modify: `tools/src/cli.ts`
- Modify: `tools/src/deployment.ts`
- Modify: `justfile`

**Interfaces:**

```ts
export type UpgradeStep = {
  contract: string;
  kind: "uups" | "validator-beacon";
  calldata: string;
};

export type UpgradePlan = {
  deploymentId: string;
  fromRevision: number;
  targetSnapshotPath: string;
  steps: UpgradeStep[];
};
```

```text
just upgrade <deployment-id> source=<absolute-or-empty> \
  contracts='PoRepMarket,DataCapEvidenceAdapter'
```

- [ ] **Step 1: Write failing plan validation tests**

Reject unknown contracts, duplicate steps, stale `fromRevision`, proxy implementation mismatches, missing upgrader role, non-empty calldata without explicit hex, and attempts to upgrade direct contracts such as the current `FilecoinPayV1`.

- [ ] **Step 2: Reuse upstream upgrade scripts**

Seed the selected target snapshot's native deployment artifact from `<deployment-id>/native/porep-market.json`. Use `script/Upgrade.s.sol` for named UUPS contracts and `script/UpgradeValidatorBeacon.s.sol` for the validator beacon. Do not reimplement those Solidity upgrade calls in TypeScript.

- [ ] **Step 3: Preflight every step before the first transaction**

Confirm chain/deployment revision, live current implementation, source artifact's previous implementation, upgrader role, compiled target existence, and calldata format for every requested step.

- [ ] **Step 4: Execute steps sequentially and record partial success honestly**

Multi-contract EOA upgrades are not atomic. After each transaction, write an append-only step receipt. If step three fails after two successes, keep the two receipts, do not publish a completed revision, and report the exact recovery command.

- [ ] **Step 5: Publish a new revision**

After all steps pass, read live proxy/beacon implementations, code hashes, roles, and wiring. Publish revision `N+1` with `parentRevision: N`, the new target identity, transaction receipts, and unchanged proxy addresses.

- [ ] **Step 6: Verify access-control failures**

Attempt the same upgrade with the unauthorized test identity and assert the exact custom error/revert. Confirm no implementation pointer or revision changed.

---

### Task 10: Add one populated-state upgrade continuity workflow

**Files:**
- Create: `e2e/src/scenarios/upgradeContinuity.ts`
- Create: `e2e/test/upgrade-continuity.test.ts`
- Modify: `e2e/src/scenarios/registry.ts`
- Modify: `e2e/src/contracts/views.ts`
- Modify: `justfile`

**Interfaces:**

```text
just test-upgrade from=<deployment-id> source=<new-source> \
  contracts='PoRepMarket,DataCapEvidenceAdapter,...'
```

- [ ] **Step 1: Define the pre-upgrade state record**

Record proxy addresses, implementation addresses, roles, wiring, provider/offer, at least one accepted deal, one active evidence-backed deal, one payment rail/cursor, balances, and one validator created through the beacon.

- [ ] **Step 2: Populate state using existing flows**

Reuse provider, proposal, DataCap evidence, activation, and settlement helpers. Use event-derived IDs and write `upgrade-before.json`.

- [ ] **Step 3: Invoke the explicit upgrade plan**

Run `scripts/devnet-upgrade.sh` against the same deployment ID. Reload revision `N+1`.

- [ ] **Step 4: Assert continuity**

Require unchanged proxy/beacon addresses, changed requested implementations, unchanged roles/wiring, identical stored deal/rail/evidence fields, and the same Validator proxy now executing the new beacon implementation.

- [ ] **Step 5: Continue old state and create new state**

Settle or refresh the pre-upgrade deal, then create and progress a new post-upgrade deal. This catches both storage corruption and a new implementation that only works for freshly created objects.

- [ ] **Step 6: Run upgrade tests separately**

Do not put this stateful sequence into the alphabetical full matrix. The command owns its baseline deployment, populated state, upgrade, and continuation phases.

---

### Task 11: Fill the highest-value release/security scenario gaps

**Files:**
- Create: `e2e/src/scenarios/terminationSettlement.ts`
- Create: `e2e/src/scenarios/curioRestartReplay.ts`
- Create: focused tests under `e2e/test/`
- Modify: `e2e/src/scenarios/registry.ts`
- Modify: `e2e/src/runtime.ts`

**Interfaces:**
- Both scenarios use the existing static registry and `security` tag.
- Failure diagnostics include bounded Curio/Lotus/Yugabyte logs, deployment revision, transaction receipts, and scenario state IDs.

- [ ] **Step 1: Add the composed termination/stale-evidence accounting scenario**

Exercise the real `DataCapEvidenceAdapter -> PoRepMarket -> Validator -> FilecoinPay` path. Record the settlement cursor and balances before termination/staleness, refresh/settle, then assert the cursor cannot advance across an unintentionally zero-paid interval.

- [ ] **Step 2: Add one Curio restart/replay scenario**

Create a signed onboarding request, restart Curio at a deterministic pipeline boundary, and assert exactly one terminal outcome: one accepted completion or one retained rejection, never duplicate receiver effects or lost unobservable work.

- [ ] **Step 3: Keep fault injection bounded**

Do not add a chaos engine. Additional security cases are ordinary named scenarios with exact setup, failure point, timeout, and oracle.

- [ ] **Step 4: Verify repeated non-clean execution**

Run the `security` suite twice on one chain and deployment. Fail any scenario that assumes zero counters, fixed IDs, matrix order, or an empty receiver/database.

---

## Final verification gates

- [ ] `npm --prefix tools run typecheck`
- [ ] `npm --prefix tools test`
- [ ] `npm --prefix e2e run typecheck`
- [ ] `npm --prefix e2e run test:unit`
- [ ] `bash scripts/static-checks.sh`
- [ ] `just test-contracts`
- [ ] Two fresh deployments of the same target on one unchanged chain
- [ ] Two consecutive `contract` suites on one deployment
- [ ] Two consecutive active-sector scenarios with fixture reuse
- [ ] One explicit old-target to new-target upgrade continuity workflow
- [ ] One unauthorized upgrade rejection
- [ ] One explicit `test-fresh` qualification run from a new chain generation
- [ ] Read back every run summary and verify source target, deployment ID, revision, chain generation, proxy/beacon implementation hashes, scenario result, and artifact paths

## Deliberately deferred

- ZigZag build/genesis/proof integration
- Automatic state snapshot/restore
- Automatic PR checkout discovery
- Generic runtime profiles
- Dynamic scenario plugins
- Atomic multi-contract admin executor
- Harness-owned storage-layout validator
- General reorg or chaos laboratory

These are added only after a concrete experiment or failure requires them.
