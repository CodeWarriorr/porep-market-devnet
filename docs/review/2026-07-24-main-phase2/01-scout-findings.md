# Phase 2 scout findings

Patch reviewed initially:
`402b1f089f70de6f275eb169f8587c5c35d6289df21275e0917e6e9a4f1edbc7`.

## Architect / flow scout

- WARNING: `just status` used a TCP connect as Market readiness. A bound port
  could pass while the HTTP handler was unusable.
- WARNING: status wrote `control: []` without querying the provider's control
  addresses.
- Zero Critical findings. Project-scoped `up`, `down`, and `reset` flow was
  otherwise coherent.

## Bug / integration scout

- WARNING: serial 30-second probes and diagnostics could extend the documented
  20-minute status bound.
- WARNING: `curl` and `jq` were used but absent from the published host
  prerequisites; missing `curl` would cause a long false wait.
- WARNING: same unqueried control-address evidence as the flow scout.
- Zero Critical findings.

## Remediation supplied to verifier

- Market readiness now requires Curio's documented `GET /health` response.
- owner, worker, control addresses, and sector size now come from live
  `Filecoin.StateMinerInfo`; a chain-reported `null` control list is normalized
  to the actual empty array.
- one absolute deadline starts before the initial Compose probe; convergence
  reserves 65 seconds and every diagnostic timeout and poll sleep shrinks
  against the remaining wall budget.
- `curl` is required fail-fast and README prerequisites now list `curl` and
  `jq`.
- focused status tests, typecheck, shell syntax, live `just status`, and
  `git diff --check` pass. Live status passed for provider `t01004` at epoch
  306 with HTTP Market readiness and the chain-reported empty control list.

The verifier returned `READY_AFTER_FIXES` on patch
`74af0c542c9875111341debb84259a6ee0947621b7846704518f56d6b3b497de`
with only the absolute wall-clock accounting warning still open. The main
thread closed that concrete script finding under Lean Execution Mode.

Final Phase 2 patch:
`fc23844053af905c63144cf9e415994d2f744402c6f57cbae7088bcc4f156f27`
(5,856 lines, 236,245 bytes).
