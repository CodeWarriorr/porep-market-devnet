# PoRep Market Curio DevNet

This repository is a self-contained local integration harness for a pinned
Curio DevNet and the PoRep Market contract ecosystem. The authoritative source,
image, tool, and chain pins are in `versions.lock.yaml`.

## Architecture and ownership

Tracked orchestration lives in this repository. Exact detached source checkouts
are managed exclusively under `.cache/sources/<name>/<commit>/`; chain state,
test-only identities, deployment manifests, logs, and run evidence live under
`.runtime/`. Neither path is committed. The default workflow never uses a
sibling checkout, Git submodule, or global project dependency.

## Host prerequisites

Install Git, Docker with Compose, `just` 1.46 or newer, Node.js 20 or newer,
`curl`, `jq`, and `lsof`. The selected Node version is recorded in
`versions.lock.yaml`.
The verified host was Apple arm64 with 10 CPUs, 24 GiB host RAM, and 7.65 GiB
assigned to Docker. Allow at least 14 GiB free disk for images, proof
parameters, and one active runtime.

## Current workflow

Inspect the stable command surface with:

```sh
just --list
```

Bootstrap installs the locked tooling package, then fetches and verifies the
pinned detached source checkouts:

```sh
just bootstrap
```

Build the seven project-scoped Curio images from the verified managed checkout:

```sh
just build
```

The build resolves every base image through `versions.lock.yaml`, validates the
current platform child digest, and writes inspected image IDs and labels to
`.runtime/devnet/build/images.json`. The complete build is bounded to 90
minutes. Plain BuildKit output is retained under `.runtime/devnet/logs/` on
success or failure. Re-running `just build` uses the same exact tags and safely
reuses BuildKit cache.

The unit gate typechecks the tooling and E2E packages, runs their unit tests,
and runs the small repository safety checks:

```sh
just test-unit
```

## Command timeouts

`just bootstrap`, `just build`, and `just test-unit` run their external work through the
dependency-free `scripts/run-with-timeout.mjs` helper. Bootstrap bounds the
Node version check to 15 seconds, lock verification to 60 seconds, `npm ci` to
10 minutes, source fetch to 20 minutes, and source verification to 5 minutes.
The complete image build is bounded to 90 minutes.
The typecheck and static-check steps are bounded to 60 seconds and unit tests
to 10 minutes. On a timeout or external SIGINT/SIGTERM, the helper forwards the
signal to the command process group, waits five seconds, then sends SIGKILL if
needed. Timeout exits use status 124; external SIGINT/SIGTERM exits use 130 or
143. Diagnostics identify the executable and last stderr tail without printing
environment variables or command arguments.

`just up`, `just down`, `just reset`, and `just logs [service]` provide the
project-scoped lifecycle surface. Before startup, `just up` checks required
services and locked images, loopback/unique ports, project-owned bind mounts,
and the absence of fixed container identities. Logging options, restart
policy, service ordering, and exact healthcheck command text are intentionally
not treated as protocol contracts. `just status` performs the strict checks
that matter at runtime: Lotus/Curio versions, FEVM chain ID, network and actor
versions, provider, sector size, Curio APIs, Market endpoint, and database
readiness. It writes the snapshot to
`.runtime/devnet/status/latest.json`.

`just up` and `just down` retain state. `just reset` is disposable by design:
it keeps only a bounded log tail and small identity JSON under
`.runtime/reset-evidence/`, deletes this project's chain/database/fixture
state and private deployment identities, and starts a new generation. Public
deployment revisions and scenario runs remain for comparison. Reset never
removes proof parameters, source/build caches, images, or resources from
another project.

## Contract targets and deployments

Run the selected PoRep Market repository's own Foundry suite before an
expensive deployment:

```sh
just test-contracts
just test-contracts source=/absolute/path/to/porep-market
```

With no `source`, the locked clean checkout is used. An explicit absolute
checkout may be dirty. In both cases the harness creates an immutable target
snapshot and builds/tests/deploys that snapshot, so edits made after a command
starts cannot change the run.

After `just status` is ready, deploy a fresh contract graph on the current
chain:

```sh
just deploy
just deploy source=/absolute/path/to/porep-market
just addresses
```

Every deployment is append-only under
`.runtime/deployments/<deployment-id>/revisions/000.json`. Deploying again on
the same chain creates another independent graph; it does not silently reuse
or overwrite the previous one. `.runtime/deployments/active.json` selects the
revision used by scenarios:

```sh
just use-deployment deployment-... revision=latest
just addresses deployment=active
just tooling-env deployment=active
```

Each revision records the contract target, chain generation, flexible
contract map, proxy/beacon implementations, and live code hashes. Extra
contracts are accepted. Private test keys remain only in the ignored
deployment directory.

`just tooling-env` validates the active chain identity and deployed bytecode,
then prints public dotenv values used by the Python tooling and oracle. It does
not print signing keys or configure the oracle database, roles, or scheduler.

## Scenarios and repeated runs

Run the migrated TypeScript preflight or one named scenario with:

```sh
just test-scenario preflight
just test-scenario proposal-smoke
just test-scenario direct-onboarding-notification
just test-scenario sector-status-active
```

Preflight validates the selected immutable deployment revision, current
generation, live proxy/beacon implementations, Curio/provider state, funded
identities, provider offer, wiring/roles, USDC, and MetaAllocator authority.
It does not require an exact total contract or ABI count. Every run publishes
one success/failure summary and bounded failure diagnostics under
`.runtime/runs/`.

The static registry defines only tags, timeout, required contracts, and fixture
requirements. Run a suite with:

```sh
just test-e2e contract
just test-e2e curio
just test-e2e security
just test-e2e full
```

The `contract` suite is the fast development loop and avoids Curio sealing.
The `curio` suite owns notification and sector flows. The `security` suite
includes access-control, rejection, termination-settlement, and restart/replay
cases, so it can include real sealing and is a qualification suite rather than
the default edit/test loop. Active-sector fixtures are stored by chain
generation and revalidated against Lotus, so sector scenarios can run alone or
repeatedly. Provider setup preserves already committed and pending capacity.

`just test-all` keeps the current chain, runs the selected target's canonical
tests, creates a fresh graph, and runs the requested suite:

```sh
just test-all /absolute/path/to/porep-market contract
```

Use `just test-fresh` only for the explicit qualification lane. It resets the
chain, deploys the locked clean target, then runs the contract and Curio
suites. Together those suites already contain every security-tagged scenario;
use the security suite directly for a focused security run.

## Upgrade testing

Upgrade one or more supported UUPS contracts or the Validator beacon using the
selected PoRep Market checkout's own upgrade scripts:

```sh
just upgrade deployment-... \
  'PoRepMarket,DataCapEvidenceAdapter' \
  /absolute/path/to/new-porep-market
```

Only the checks needed to keep an in-place upgrade recoverable are enforced:
the deployment revision must still be current, the caller must have upgrade
authority, and the requested contracts must have supported upstream upgrade
scripts. A per-deployment lock prevents concurrent upgrades. The prepared
target, plan, and successful step receipts form a resumable journal because
multiple EOA upgrades cannot be atomic. If a run is interrupted, rerun the same
command. A new deployment revision is published only after each live
implementation equals the implementation produced by the selected source and
its compiled runtime bytecode hash matches.

The populated-state workflow creates an active deal and rail, upgrades, checks
unchanged proxy addresses and stored deal/evidence/payment state, continues
the old deal, and creates a new deal:

```sh
just test-upgrade deployment-... \
  'PoRepMarket,DataCapEvidenceAdapter' \
  /absolute/path/to/new-porep-market
```

This workflow is intentionally excluded from ordinary matrices.

Forge deployment and upgrade processes use a process-local JSON-RPC adapter
for Lotus null epochs. It represents a null epoch as an empty Ethereum-shaped
block so Foundry does not retry forever. Ordinary scenarios and public RPC
traffic still talk directly to Lotus.

## ZigZag boundary

ZigZag is not a contract scenario or a runtime toggle. It changes
genesis/consensus/proof integration and should use a separate DevNet build
lane or sibling harness when that experiment starts. The market scenario
package and deployment-revision format can be reused against that lane, but
this harness does not carry a generic profile/plugin system before there is a
concrete ZigZag node image, genesis builder, and readiness contract.

## Public endpoint defaults

The lifecycle commands generate their ignored Compose environment from the
verified lock, managed source commits, and active image manifest. `.env` is not
used as a lifecycle input. Defaults are the Compose project `porep-market-curio-devnet`, Filecoin JSON-RPC at
`http://127.0.0.1:2234/rpc/v1`, Curio Market at `http://127.0.0.1:22310`, Curio
API at `http://127.0.0.1:22300`, and Curio UI at `http://127.0.0.1:24701`.

## Lifecycle safety

`up`, `status`, `logs`, and `down` are designed as non-destructive lifecycle or
diagnostic commands. `reset` is the only destructive public command. Every
active or archive path and ancestor is checked for the exact repository,
expected type, canonical real path, and absence of symbolic links before a
write. Existing ownership markers must match their canonical content and are
never overwritten on mismatch.

## Diagnostics

`just logs [service]` returns a 300-line, 30-minute bounded tail for the full
project or one of the seven allowlisted services. Runtime evidence, deployment
manifests, and diagnostics are written under `.runtime/`; static safety checks
are available through `bash scripts/static-checks.sh`.

Measured standalone commands, CLI access, restart/reset behavior, and current
Phase 2 boundaries are documented in
`docs/runtime/curio-devnet.md`.
