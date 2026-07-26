# Phase 4 TypeScript Harness Migration Implementation Plan

> **Execution:** Implement inline in the main thread with TDD. Do not use
> subagents. Git writes remain forbidden in this repository.

**Goal:** Migrate all 36 source files, 13 unit-test files, and 14 registered
Boost-hosted V2 scenarios into this repository without retaining a Boost
runtime dependency.

**Architecture:** Keep the migrated harness as one small `e2e/` TypeScript
package so its existing flows remain readable. Load current addresses and
test-only keys from this repository's ignored deployment files. Replace only
the old Boost/Docker boundary with direct commands against the exact
`porep-market-curio-devnet` services; do not redesign contract flows.

**Tech Stack:** Node.js 20, TypeScript, ethers v6, existing bounded shell
runner, Docker Compose, Curio Market 2.0, Lotus JSON-RPC.

## Global constraints

- Preserve exactly the 14 existing scenario command names and their intended
  assertions.
- Do not copy `node_modules`, runtime state, old `.env` files, or source
  checkouts.
- Default configuration comes from `.runtime/deployments/latest.json`,
  `.runtime/deployments/identities.private.json`, `versions.lock.yaml`, and
  `.runtime/devnet/status/latest.json`.
- Use the existing managed PoRep checkout and runtime build artifacts for ABIs.
- Keep state-changing flows and assertions in TypeScript.
- Shell is limited to bounded project CLI calls and Curio/Lotus operations.
- Phase 4 proves migration, unit behavior, and strict preflight. Live scenario
  outcomes remain Phase 5/6 gates.

---

## Task 1: Mechanical migration and exact path map

**Files:**

- Create: `e2e/package.json`, `e2e/package-lock.json`, `e2e/tsconfig.json`
- Create: `e2e/src/**/*.ts` from the 36 reference source files
- Create: `e2e/test/**/*.test.ts` from the 13 reference tests
- Create: `e2e/migration-map.json`
- Create: `e2e/test/migration-map.test.ts`
- Modify: `.gitignore`, `justfile`

**Produces:**

- a standalone installable package;
- a tracked map from every reference path at commit
  `62bd2e7bae2a8dbef5d78cfd19dcc8a2115bdec8` to its repository-local path.

- [x] Copy only `package*.json`, `tsconfig.json`, `src/**/*.ts`, and
  `test/**/*.test.ts`; rename `src/devnet/boost.ts` and `test/boost.test.ts` to
  `curio.ts` equivalents without changing behavior yet.
- [x] Generate `migration-map.json` with `sourceCommit`, `sourceRoot`, and 49
  `{source,destination}` rows; use repository-relative paths only.
- [x] Add a test that requires exactly 36 mapped source files, 13 mapped
  original tests, unique source/destination paths, and an existing destination
  for every row.
- [x] Run the focused migration-map test and record RED before the map exists,
  then GREEN after it is complete.
- [x] Run `npm ci --prefix e2e`; do not copy the reference `node_modules`.

## Task 2: Current manifest configuration and project command boundary

**Files:**

- Modify: `e2e/src/config.ts`, `e2e/src/runtime.ts`, `e2e/src/shell.ts`
- Modify: `e2e/src/contracts/abi.ts`, `e2e/src/contracts/evm.ts`
- Modify: `e2e/src/devnet/docker.ts`, `e2e/src/devnet/lotus.ts`
- Modify: corresponding migrated unit tests

**Produces:**

- `loadConfig()` bound to the current deployment generation and source refs;
- one bounded command adapter that runs `cast` inside the project Curio image
  and Lotus commands through the exact Compose project.

- [x] Add failing tests requiring manifest-derived addresses, role keys from
  `identities.private.json`, RPC `http://127.0.0.1:2234/rpc/v1`, current
  generation/source checks, `.runtime/runs/`, and no `.env`/sibling checkout.
- [x] Implement the minimum parser/adaptor needed by the existing
  `ScenarioContext`; preserve existing field names where that avoids flow
  rewrites.
- [x] Change ABI lookup to the managed/runtime PoRep, FilecoinPay, and harness
  artifacts used by the current deployment.
- [x] Replace hard-coded Lotus/cast execution with exact project
  service commands. Keep every wait bounded and redact private arguments from
  failures.
- [x] Run config, runtime, EVM, ABI, Lotus, and state unit tests plus typecheck.

## Task 3: Curio provider boundary and 14-scenario registry

**Files:**

- Modify: `e2e/src/devnet/curio.ts`
- Modify: `e2e/src/flows/datacap.ts`
- Modify: `e2e/src/scenarios/registry.ts`
- Modify: `e2e/test/curio.test.ts`, `e2e/test/scenario-registry.test.ts`,
  `e2e/test/scenario-guard.test.ts`

**Produces:**

- a Curio readiness/piece-onboarding boundary used by migrated flows;
- exactly the original 14 command names, with `prepare-devnet` reduced to a
  current-state check because the pinned Curio DevNet already owns fast
  sealing configuration.

- [x] Add failing tests forbidding Boost container names, Boost APIs,
  `boostd import-direct`, sibling roots, old setup scripts, and mutable provider
  config edits.
- [x] Implement Curio readiness against the current status/Market endpoint.
  Keep actual FIP-0109 DDO submission for Phase 5, but expose the typed function
  boundary needed by the migrated DataCap flow.
- [x] Preserve all 14 registry names and remove only Boost-specific preparation
  behavior; do not weaken contract assertions.
- [x] Run registry, guard, Curio, and DataCap unit tests.

## Task 4: Strict preflight and public commands

**Files:**

- Modify: `e2e/src/preflight.ts`, `e2e/src/cli.ts`
- Modify: `e2e/test/preflight.test.ts`, `e2e/test/cli.test.ts`
- Modify: `scripts/static-checks.sh`, `justfile`, `README.md`
- Modify: `docs/goals/2026-07-24-complete-porep-market-curio-devnet.md`
- Modify: `.superpowers/sdd/progress.md`

**Produces:**

- `just test-scenario <name>`;
- a fail-closed preflight for current status, deployment, source refs, ABIs,
  bytecode, funding, provider, offer, and required role wiring.

- [x] Add failing tests for the public recipe, exact 14-name registry, current
  generation/chain/provider/source checks, code at required addresses, funded
  roles, active provider/offer, and actionable bounded failures.
- [x] Implement preflight using the existing status/deployment validation and
  direct live reads; do not add a second schema framework.
- [x] Wire `just test-scenario <name>` through the bounded runner and preserve
  summaries under `.runtime/runs/`.
- [x] Run `npm --prefix e2e run typecheck`,
  `npm --prefix e2e run test:unit`, root `just test-unit`, source verification,
  shell syntax, and `git diff --check`.
- [x] Run one focused main-thread Phase 4 check against the migration map and
  checklist, update the ledger, and stop before claiming any live scenario
  passed.

## Completion gate

Phase 4 closes only when all 49 original TypeScript files are mapped, all 14
commands remain registered, all migrated and root unit gates pass, strict
preflight accepts the current Curio deployment, and tracked files contain no
Boost runtime dependency or sibling-checkout requirement.
