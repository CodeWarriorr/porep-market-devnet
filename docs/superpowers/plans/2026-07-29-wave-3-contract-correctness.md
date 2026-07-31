# Wave 3 Contract Correctness Plan

**Goal:** Cover Wave 3 scarcity and adversarial-input behavior against the
pinned PoRep Market and FilecoinPay contracts with exact assertions.

## Scope Boundary

- Test the contracts. Do not build another test framework and then test that
  framework.
- Reuse the existing TypeScript flows, scenario runner, contract views, revert
  decoder, Curio onboarding path, and matrix reporting.
- Do not add dependencies, runners, generic lifecycle or scarcity
  abstractions, configuration layers, CI jobs, Solidity changes, or unrelated
  refactors.
- Add a narrow optional helper argument only when a current helper prevents the
  scenario from reaching its required state. Otherwise keep setup local.
- Do not patch every issue found during implementation. Record unrelated
  defects unless they block a Wave 3 assertion.
- Test intended behavior even when the pinned deployment fails. Preserve the
  deterministic red scenario and report the exact mismatch.
- Never work around a product-contract bug in the harness. Do not accept an
  alternate outcome, add a skip, branch on deployed behavior, compensate for
  the bug in test setup, or weaken an assertion. The purpose of this harness is
  to expose these bugs. Leave the test failing and report the bug with the
  exact expected value, actual value, contract revision, and transaction or
  revert evidence.
- A failing or blocked scenario does not stop the Wave. Preserve its failure
  evidence, identify the affected scenario and boundary, then continue every
  independent Wave 3 scenario and verification step that remains possible.
  Report partial completion accurately; do not let one product bug or
  scenario-specific infrastructure problem hide results from the other tests.
- Assert exact custom errors and arguments, then assert relevant state is
  unchanged.
- Compute expected money, cursor, and capacity values independently in
  TypeScript.

## Suite Placement

Do not create a permanent `wave3` suite. Wave numbers describe implementation
order, not a durable runtime capability.

| Scenario | Existing suite |
| --- | --- |
| B-1 client funds exhaustion | `curio`, `sealing` |
| E-2 capacity exhaustion | `contract` |
| F-1 malformed CBOR | `contract`, `security` |
| F-3 posting-order guards | `contract`, `security` |
| F-4 short allocation | existing Curio scenario |

F-2 `adapter-disable` is destructive because `disableAdapter()` is irreversible.
Exclude it from every normal matrix and run it directly with
`just test-scenario adapter-disable` on a disposable deployment. One
destructive scenario does not justify another suite.

## Scenario Changes

### B-1: Client funds exhaustion

Create `e2e/src/scenarios/clientFundsExhaustion.ts`.

- Activate a real deal and set settlement cadence to one epoch.
- Deposit an exact bounded amount without automatic extra minting.
- Assert exact payments, payer/payee deltas, lockup fields, and cursor at the
  funded cutoff.
- Top up the same account and assert settlement resumes from that cursor with
  no lost or double-paid epochs.

### E-2: Provider capacity exhaustion

Create `e2e/src/scenarios/capacityExhaustion.ts`.

- Preserve one explicitly selected provider capacity instead of auto-growing
  it.
- Reserve deals until the next proposal exceeds capacity.
- Assert exact capacity, exact `CommitExceedsAvailable` arguments, and that
  earlier deals remain unchanged.

### F-1: Malformed DataCap CBOR

Create `e2e/src/scenarios/datacapMalformedInput.ts`.

- Use a fixed set of malformed payloads: wrong top-level arity, wrong
  allocation arity, wrong extension arity, truncated bytes, nested junk, and
  empty arrays where a contract guard is defined.
- Assert the intended `InvalidOperatorData`, `InvalidAllocationRequest`, or
  `InvalidClaimExtensionRequest` error.
- After every revert, assert deal, rail, allocation, posting, and adapter state
  is unchanged.
- Finish with one valid submission to prove the adapter still operates.
- Keep payload construction local; do not create a CBOR framework or fuzzer.

### F-2: Adapter disable

Create `e2e/src/scenarios/adapterDisable.ts`.

- Establish the required accepted or active deal first.
- Assert disable succeeds, submission then fails with
  `AdapterNotOperational`, and a second disable fails with
  `AdapterAlreadyNonOperational`.
- Assert the intended behavior of the existing deal with exact deal, evidence,
  rail, and payment state.
- Run only on a disposable deployment.

### F-3: Posting-order guards

Extend `e2e/src/scenarios/evidenceNoClaimActivationGuard.ts`.

- After posting finishes: `PostingAlreadyFinished`.
- Evidence before posting finishes: `PostingNotFinished`.
- Refresh before CLAIMED: `InvalidAllocationState`.
- Assert exact errors and unchanged state after each call.

### F-4: Allocation shorter than requested

Extend `e2e/src/scenarios/multiClaimEvidenceBatches.ts`.

- On a separate deal, allocate less than `requestedSizeBytes`.
- Assert `InvalidAllocatedBytes`, ACCEPTED state, unfinished posting, zero
  committed bytes, and unchanged provider capacity.
- Leave the existing successful multi-claim path intact.

## Minimal Supporting Changes

Touch only when required:

- `e2e/src/flows/validatorRail.ts`: exact bounded deposit for B-1.
- `e2e/src/flows/provider.ts`: preserve explicit capacity for E-2.
- `e2e/src/flows/datacap.ts`: fixed DataCap guard helpers.
- `e2e/src/contracts/views.ts`: missing reads needed by assertions.
- `e2e/src/scenarios/registry.ts`: register scenarios and exclude F-2 from
  normal suites.
- Focused unit tests for pure helper and registry behavior.

## Verification

1. Run every new or extended scenario directly.
2. Change one decisive assertion per scenario, confirm it fails for that
   assertion, restore it, and rerun.
3. Run `just test-unit`.
4. Run the complete `contract` suite.
5. Run touched Curio scenarios and the complete `curio` suite.
6. Run F-2 last on a disposable deployment, then reset or redeploy.

Wave 3 needs ordinary transaction and sealing time only. It does not require
the 23,040-epoch stale-evidence wait, the 86,400-epoch attestation-expiry wait,
or the 518,400-epoch service lifecycle.

For the affected scenario, stop expanding scope and report when:

- PoRep Market and FilecoinPay intended behavior conflict.
- A scenario would require a product-contract change.
- Curio or chain health blocks runtime verification.
- Completing a scenario starts requiring a framework, dependency, or broad
  refactor.

After recording that scenario's blocker or deterministic failure, continue all
independent scenarios. Stop the overall Wave only when a shared infrastructure
failure makes further verification impossible.
