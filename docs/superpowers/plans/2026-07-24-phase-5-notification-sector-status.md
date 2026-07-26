# Phase 5 Notification and Sector Status Implementation Plan

> **Execution:** Implement inline in the main thread with focused tests. Do not
> use subagents. Git writes remain forbidden in this repository.

**Goal:** Prove one real Curio Market 2.0 direct-onboarding notification, its
failure behavior, and FIP-0112 status for the resulting sector.

**Architecture:** Keep Curio at the pinned commit. Apply one tracked,
build-time-only patch that exposes Curio's existing `DDOV1.NotificationAddress`
and `NotificationPayload` fields through `sptool`; do not implement a second
authentication client. Keep submission, polling, assertions, and run evidence
in the existing TypeScript Curio boundary.

**Tech Stack:** Pinned Curio/`sptool`, Docker Compose, TypeScript, ethers v6,
Foundry, Lotus JSON-RPC, Yugabyte readbacks.

## Global Constraints

- Use the real Curio Market 2.0 signed request and real sealing pipeline.
- Preserve exact managed-source cleanliness; the patch is copied into the
  Docker build and is never applied to `.cache/sources/curio/...`.
- Store raw deal, message, notification, allocation, claim, and sector evidence
  under the scenario run directory.
- Keep all subprocesses and polling bounded.
- Add only the four required scenario names. Do not add generic security or
  adversarial fixtures.
- Execute inline with zero subagent calls.

---

### Task 1: Expose the existing notification fields in `sptool`

**Files:**

- Create: `patches/curio/0001-sptool-mk20-notification-flags.patch`
- Modify: `docker/curio-all-in-one.Dockerfile`
- Modify: `scripts/devnet-build.sh`
- Test: `tools/test/devnet.test.ts`

**Produces:** Stock Curio auth and request handling with two additional CLI
inputs: `--notification-address <Filecoin address>` and
`--notification-payload <hex bytes>`.

- [x] Add a failing static test requiring both flags, their assignment to
  `DDOV1`, a named build context, and clean managed-source verification.
- [x] Add the minimal Go diff: parse the Filecoin address with
  `address.NewFromString`, decode the optional `0x`-prefixed payload with
  `hex.DecodeString`, reject payload without address, and assign both fields.
- [x] Copy and apply the patch in the Curio builder stage from a read-only
  `harness-overlay` build context.
- [x] Run the focused test, source verification, rebuild, and verify
  `sptool ... deal --help` lists both flags while the managed Curio checkout is
  still detached and clean.

### Task 2: Submit and observe a successful notification

**Files:**

- Modify: `contracts/src/NotificationReceiver.sol`
- Modify: `contracts/test/HarnessContracts.t.sol`
- Modify: `contracts/remappings.txt`
- Modify: `e2e/src/devnet/curio.ts`
- Modify: `e2e/src/devnet/piece.ts`
- Modify: `e2e/test/curio.test.ts`

**Produces:** `submitCurioOnboarding(...)` and bounded status/readback methods
that return the Curio deal ULID, allocation ID, claim ID, piece CID/size,
sector number, activation epoch, notification transaction/message references,
and receiver state.

- [x] Add focused failing tests for the exact `sptool` command, notification
  payload/address, bounded deal/claim/sector polling, and run-artifact writes.
- [x] Use `FVMSectorContentChanged` to decode the live sector pieces in
  `NotificationReceiver`; persist sector number, minimum commitment epoch,
  piece digest, padded size, payload, call count, and raw params; return the
  library's exact accepted response.
- [x] Generate the piece, create the allocation using the existing DataCap
  flow, submit the signed Curio DDO, and poll Curio/Lotus/receiver state with a
  two-hour outer bound and useful diagnostics.
- [x] Run `direct-onboarding-notification` and assert one actor callback, the
  expected payload, provider `t01004`, piece CID/size, allocation/claim, and
  sector association from runtime evidence.

### Task 3: Prove failure semantics and FIP-0112

**Files:**

- Modify: `e2e/src/devnet/curio.ts`
- Modify: `e2e/src/scenarios/registry.ts`
- Create: `e2e/src/scenarios/direct-onboarding-notification.ts`
- Create: `e2e/src/scenarios/direct-onboarding-notification-failure.ts`
- Create: `e2e/src/scenarios/sector-status-active.ts`
- Create: `e2e/src/scenarios/sector-status-negative.ts`
- Modify: corresponding focused unit tests

**Produces:** The four required scenario commands with live evidence.

- [x] Register exactly the four new names without changing the original 14.
- [x] Submit a deal to `FailingNotificationReceiver` and prove Curio's current
  `RequireNotificationSuccess=true` behavior from the failed prove-commit
  message and absent activation; record optional-failure behavior only if it
  can be toggled through the existing Curio layer config without a source
  change.
- [x] Call the deployed `SectorStatusInspector` against the successful
  notification's actual deal/provider/sector and prove the active status.
- [x] Call the same built-in actor path with an unknown sector and assert the
  negative result or exact revert.
- [x] Run all four scenarios individually and retain their reports.

### Task 4: Close the Phase 5 gate

**Files:**

- Modify: `README.md`
- Modify: `docs/goals/2026-07-24-complete-porep-market-curio-devnet.md`
- Modify: `.superpowers/sdd/progress.md`

**Produces:** Current checklist, scenario matrix, and ledger evidence.

- [x] Run the affected unit/type/static/source gates and `git diff --check`.
- [x] Read back Curio deal rows, Lotus allocation/claim/sector state, receiver
  fields/events, notification message receipt, and FIP-0112 results.
- [x] Check only the Phase 5 items and four new matrix rows proven by those
  commands; leave all original live scenarios unchecked.
- [x] Record exact IDs, commands, exits, timings, and artifact paths, then
  continue to Phase 6 without claiming full-goal completion.

## Completion Gate

Phase 5 closes only when the successful callback, required failure behavior,
active-sector result, and unknown-sector result are all proven from one current
DevNet generation and the managed Curio checkout remains exact and clean.
