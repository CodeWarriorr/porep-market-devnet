# PoRep Market DevNet E2E Instructions

## Purpose

This repository is the integration and end-to-end testing hub for PoRep Market.
Its primary output is evidence that the contracts produce the intended values
and lifecycle transitions on the pinned Filecoin DevNet.

Read these requirements before changing `e2e/`:

- `/Users/mmach/mind_vault/projects/porep-market/2026-07-28-e2e-implementation-prompt.md`
- `/Users/mmach/mind_vault/projects/porep-market/2026-07-28-e2e-testing-strategy-and-false-confidence.md`
- `/Users/mmach/mind_vault/projects/porep-market/2026-07-28-e2e-scenario-backlog.md`

## Correctness Contract

- Test intended behavior, not merely the behavior of the currently pinned
  contract deployment.
- A deterministic failing E2E scenario is a valid result when the deployed
  contracts do not implement the intended behavior. Report the exact mismatch;
  do not weaken, branch, skip, or remove the assertion to make the suite green.
- Compute expected monetary values independently in TypeScript. Do not derive an
  expected value from the contract event or state value being checked.
- Assert exact payment rates, payer gross deltas, payee net deltas, settlement
  cursors, deal states, capacity fields, custom errors and error arguments.
- After an expected revert, assert that relevant state is unchanged.
- A scenario must have one expected outcome. A scenario that accepts either
  success or revert is an observation, not a test.
- Keep intentional zero-payment cases distinct:
  - failing SLI forfeits the window: payment is zero and the cursor advances;
  - stale evidence is retryable: payment is zero and the cursor remains at
    `fromEpoch`;
  - terminal settlement may advance through a non-payable tail so FilecoinPay
    can finish the rail.
- Treat suspected product-contract defects as findings. Do not modify vendored
  PoRep Market, FilecoinPay, or other product contracts in this repository.

## Intended Contract Changes Under Test

Open PoRep Market PRs can define intended behavior that is newer than
`versions.lock.yaml`. Recheck their current diffs before relying on them.

- PR #121: stale evidence must not consume a settlement window.
- PR #122: expired allocation evidence has a terminal close path; cover this
  intended path even while the pinned deployment lacks it.
- PR #118: duplicate claims must not inflate evidence accounting; same-deal
  extensions spend DataCap without crediting the same evidence twice.
- PR #116: allocated bytes must respect activation-padding bounds.

If an open PR changes or conflicts with another intended behavior, preserve the
failing test and report the conflict. Do not invent an integration result.

PR #121 and PR #122 currently conflict on terminal settlement. FilecoinPay keeps
a terminated rail open through its lockup end, so PR #122 advances the rail
cursor across the non-payable tail. PR #121 instead returns `fromEpoch` after
termination and caps successful settlement at the termination epoch, which can
prevent the rail from reaching its end. Keep the PR #122 terminal-tail
assertions exact and report the deterministic failure when the branches are
integrated; do not weaken them to match either PR in isolation.

## Current E2E Goal

Implement and verify Waves 1 and 2 from the implementation prompt, plus the
expired-allocation lifecycle introduced by PR #122:

- independent rate and settlement arithmetic;
- exact rate and settlement accounting, including awkward-price rounding;
- failing-SLI forfeiture and service-end/termination caps;
- FINALIZED, REJECTED, EXPIRED and TERMINATED lifecycle paths;
- exact provider pending/committed capacity release;
- visible skipped capabilities and separate infra/behavior counts.

Wave 3 scarcity and adversarial-input scenarios are not part of this slice
unless explicitly approved later.

## Implementation Boundaries

- Work only in the TypeScript E2E harness and its tests.
- Reuse existing flows and scenario conventions.
- Do not add dependencies, frameworks, runners, configuration layers, generic
  lifecycle abstractions, CI changes, Solidity changes or unrelated refactors.
- Preserve existing user changes.
- Follow the parent Filecoin instructions: no `git add`, `git commit`,
  `git push`, `git rebase`, or GitHub writes.

## Verification

- Use test-first development for pure functions and helper behavior.
- Run every changed or new scenario with `just test-scenario <name>`.
- Prove each scenario can fail for its intended assertion, restore it, then
  rerun it.
- Run `just test-unit` after registry changes.
- Before completion, run the complete `contract` suite and any touched Curio
  suite. Report failing scenarios as contract or deployment findings with their
  exact output.
- Never claim an unexecuted or failing check passed.

## Known Bounded-E2E Limit

- A real `FINALIZED` success path is not currently reachable in a bounded run.
  PoRep Market and PR #122 both enforce a 180-day minimum deal, which produces
  a 518,400-epoch service window. At the DevNet's two-second epochs this takes
  about 12 days, while sealing scenarios have a two-hour timeout.
- Do not use a one-day deal: it fails proposal validation with
  `InvalidDealDuration` before exercising finalization. Add the success scenario
  only when the DevNet has a correctness-preserving epoch-advance mechanism or
  the product exposes a valid shorter test duration.
- PR #121's stale-evidence branch also needs more than the current two-hour
  sealing timeout: `EVIDENCE_REFRESH_GRACE_EPOCHS` is 23,040, or about 12.8
  hours at two-second epochs. Do not substitute failing SLI or data-size
  mismatch for this branch; they intentionally advance the cursor while stale
  evidence must leave it unchanged.
