# Phase 1 gate-review scout findings

Scope: the 20 Phase 1 production files represented in `diff.patch`.
Requirements: the root goal, Phase 1 implementation plan, and governing
`../AGENTS.md`. All scouts were read-only and received compact no-history
packets.

## Architect / Flow Scout

Verdict: `READY_AFTER_FIXES`.

- WARNING: `just test-unit` runs unit tests and static checks but omits the
  package's declared TypeScript typecheck. A colleague can therefore receive a
  successful public unit-gate result even when `tsc --noEmit` would fail.

No other end-to-end bootstrap, cache-ownership, exact-source, false-success, or
timeout-flow finding was reported.

## Bug / Integration Scout

- P1: `scripts/run-with-timeout.mjs` detaches the child process group but does
  not forward an external SIGINT or SIGTERM, so manual or CI cancellation can
  leave the command running.
- P1: `tools/src/process.ts` signals only the direct child on timeout, so a Git
  or submodule descendant can survive the declared per-command timeout.
- P2: bootstrap accepts Node 20.0+, while `import.meta.dirname` in the CLI and
  tests requires Node 20.11+.

The scout found no separate concrete lock-parsing, dirty-checkout, symlink,
origin, recursive-submodule, or ordinary timeout-expiry defect.

## Security Scout

Verdict: `NEEDS_REWORK`.

- CRITICAL candidate: inherited `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`,
  and related Git environment variables can redirect Git writes outside the
  validated managed cache path.
- WARNING: the same direct-child-only timeout cleanup reported by the Bug
  Scout; a controlled descendant survived.
- WARNING: the same missing external-signal forwarding reported by the Bug
  Scout; a controlled detached child survived wrapper SIGTERM.
- WARNING: `.npmrc` registry tokens are neither ignored nor recognized by the
  static secret scan.
- WARNING: the public timeout helper forwards output without respecting stream
  backpressure, allowing output buffering to grow under a slow downstream log
  consumer.
- INFO: current recursive submodule URLs are HTTPS, but the fetcher does not
  proactively restrict a future pin's submodule transport before update.

The Security Scout reported clean checks for current root URL validation,
current submodule transports and commits, path-segment validation, dirty and
detached-state rejection, symlink checks, ignore contracts, and bounded output
capture in the TypeScript process runner.

## Verification status

Every candidate above is unconfirmed until the independent Verifier /
Synthesizer reproduces it, seeks a counterexample, deduplicates it, and assigns
the gate severity in `02-verification.md`.
