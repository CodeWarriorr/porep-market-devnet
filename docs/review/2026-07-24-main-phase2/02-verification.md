# Phase 2 verification

## Independent gate result

The verifier inspected patch
`74af0c542c9875111341debb84259a6ee0947621b7846704518f56d6b3b497de`,
ran the unit/type/static checks and live `just status`, and returned
`READY_AFTER_FIXES`. Market HTTP readiness, live miner control-address
discovery, and published `curl`/`jq` prerequisites were accepted. One Warning
remained: the initial Compose probe was outside the convergence deadline and
diagnostics could exceed the advertised 20-minute status budget.

## Main-thread closure

The final script starts a 1,190-second absolute deadline before the first
Compose probe. Convergence ends 65 seconds before that deadline. Poll sleeps,
Compose probes, HTTP probes, and both diagnostic commands are constrained by
the remaining time. A regression proves deadline creation precedes the first
probe and that convergence, diagnostics, and sleeps use the absolute budget.

Current verification:

- focused/full `npm` test run: 117/117;
- `just test-unit`: typecheck, 117/117, and static checks passed;
- `bash -n scripts/devnet-status.sh`: passed;
- all nine managed source checkouts: exact, detached, and clean;
- `git diff --check`: passed;
- live `just status`: provider `t01004`, epoch 409, chain ID `0x1df5e76`,
  NV28, actors v18, Curio API/Market/database ready;
- status SHA-256:
  `bed1d8d1d3c96ec08017062fed541ab1d27500beaa90b10b3e467d3e8a2b3097`.

Final reviewed production patch SHA-256:
`fc23844053af905c63144cf9e415994d2f744402c6f57cbae7088bcc4f156f27`.

Open Critical findings: 0.

Open Warning findings: 0.
