# Phase 2 Curio DevNet Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `subagent-driven-development` to implement this plan task-by-task. Route every
> child through `adaptive-subagents`. Do not spawn nested children.

**Goal:** Build and prove a project-scoped, reproducible Curio DevNet from the
managed pinned checkout, including safe build/up/status/logs/down/reset
lifecycle commands, NV27 to NV28 activation, persistence, and measured host
requirements.

**Architecture:** The managed Curio checkout remains immutable source input.
This repository owns a transparent pinned Dockerfile, a project-owned Compose
graph, lifecycle scripts, and typed runtime inspection. Compose keeps Curio's
seven required services but removes upstream global container names, static
subnets, colliding ports, source-local state, and destructive Make targets.
All state lives under `.runtime/devnet/`; reusable proof parameters live under
`.cache/proof-parameters/`. The upstream Filecoin Services bootstrap consumes
the already managed local source checkouts. The unrelated floating Synapse SDK
manual-example bootstrap is explicitly disabled with a runtime marker.

**Tech stack:** Docker Desktop / Compose v2, BuildKit, pinned Lotus v1.36.0
DevNet image, pinned Curio `ce15c0c...`, Yugabyte, Bash, TypeScript, Node.js
20+, JSON-RPC, `just`.

## Evidence-backed constraints

- Never call Curio `make devnet/up` or `make devnet/down`; they run `rm -rf`
  against the managed checkout's `docker/data` and remove local images.
- Never edit `.cache/sources/curio/...` or any other managed source.
- Use Compose project `porep-market-curio-devnet`; omit `container_name` so
  Compose derives unique names from the project.
- Keep service DNS names (`lotus`, `lotus-miner`, `curio`, `yugabyte`,
  `piece-server`, `indexer`, `contracts-bootstrap`) because upstream
  entrypoints use them.
- Remove upstream static `172.20.0.0/16` IPAM and fixed IPs.
- Publish only required host ports, using the non-Boost defaults already
  documented in `.env.example`.
- Bind every state directory under `.runtime/devnet/data/`, not the managed
  checkout, the user's home, or anonymous volumes.
- Use `.cache/proof-parameters/` instead of `${HOME}`.
- Use `CONTRACT_SOURCE_MODE=local` with the locked managed
  `filecoin_services` and `multicall3` paths. Do not let the container clone
  floating contract sources.
- Create a `.synapse-sdk.disabled` runtime marker and point
  `SYNAPSE_SDK_READY_FILE` to it. Synapse SDK is not a Phase 2 or PoRep Market
  runtime dependency; do not clone its default branch.
- Preserve Lotus debug-network genesis NV27 and FireHorse/NV28 epoch 200.
  Runtime status must prove both the configured schedule and live NV28 before
  Phase 2 closes.
- Curio uses 8 MiB sectors even though Lotus's debug build is conventionally
  called a 2 KiB build.
- `up` and `down` are non-destructive. Only `reset` may remove this project's
  exact runtime state, and it must refuse unsafe or ambiguous paths.
- Do not touch the active Boost Compose project or its containers, network,
  volumes, ports, or source tree.
- All commands and polling loops require bounded timeouts and failure
  diagnostics.
- Git staging, commits, pushes, rebases, and GitHub writes remain forbidden.

## Planned tracked files

- `docker/curio-all-in-one.Dockerfile`: transparent pinned replacement for the
  upstream root Dockerfile, built with the managed Curio checkout as context.
- `docker/compose.curio-devnet.yaml`: project-owned seven-service graph.
- `scripts/devnet-common.sh`: repository root, lock paths, safe runtime paths,
  Compose command, project/resource allowlists, and bounded helper functions.
- `scripts/devnet-build.sh`: immutable input validation and namespaced image
  builds.
- `scripts/devnet-up.sh`: non-destructive directory preparation and Compose
  start.
- `scripts/devnet-status.sh`: bounded semantic readiness and runtime snapshot.
- `scripts/devnet-logs.sh`: allowlisted scoped logs and diagnostics.
- `scripts/devnet-down.sh`: non-destructive project stop/down without volumes
  or image removal.
- `scripts/devnet-reset.sh`: explicit exact-path/project reset and manifest
  invalidation boundary.
- `tools/src/runtime-lock.ts`: typed network/image/build/runtime lock parsing.
- `tools/src/devnet.ts`: Compose rendering/validation and runtime status
  collection.
- `tools/test/runtime-lock.test.ts`: network/image/digest lock tests.
- `tools/test/devnet.test.ts`: Compose/resource/lifecycle safety tests.
- `docs/runtime/curio-devnet.md`: measured standalone workflow and CLI access.
- Modify: `versions.lock.yaml`, `.env.example`, `.gitignore`, `justfile`,
  `README.md`, `scripts/static-checks.sh`, goal ledger/checklist, SDD progress.

## Task 1: Complete and type the immutable runtime/build lock

**Owns:**

- Modify: `versions.lock.yaml`
- Create: `tools/src/runtime-lock.ts`
- Create: `tools/test/runtime-lock.test.ts`
- Modify: `tools/src/cli.ts`
- Modify: `tools/package.json` only if a script is required

**Produces:**

- `loadRuntimeLock(path): RuntimeLock`
- CLI `runtime lock verify`
- normalized chain schedule, image manifest/platform digests, build base
  images, exact tool revisions, expected Compose project, services, and ports

- [x] **Step 1: Write failing lock-contract tests**

  Prove exact parsing and rejection for:

  - chain ID `31415926`;
  - genesis NV27 / actors v17;
  - FireHorse epoch 200 / required NV28 / actors v18;
  - exact v18 manifest and storage-miner actor CIDs;
  - Lotus and Yugabyte index plus arm64/amd64 child digests;
  - every additional Docker base/tool image used by the Dockerfile;
  - required seven-service allowlist and project name;
  - digest format `sha256:` plus 64 lowercase hex;
  - duplicate ports, invalid ports, floating tags without a digest, missing
    platform child digests, and inconsistent network schedules.

- [x] **Step 2: Run RED**

  ```sh
  npm --prefix tools test -- --test-name-pattern='runtime lock'
  ```

  Expected: nonzero because `runtime-lock.ts` and required lock fields do not
  exist.

- [x] **Step 3: Resolve immutable build inputs**

  Inspect current manifests with `docker buildx imagetools inspect`. Record
  index and arm64/amd64 child digests for every actual Docker base:

  - Lotus DevNet;
  - Yugabyte;
  - Go builder;
  - Rust toolchain;
  - Ubuntu runtime;
  - Node runtime source;
  - Foundry binary/source image if used.

  Prefer an official immutable image for Foundry and Node. If no compatible
  immutable Foundry image exists, build Foundry from the already exact source
  commit in a dedicated stage; do not use `foundryup`.

- [x] **Step 4: Implement strict typed parsing**

  Use the existing YAML/plain-record/prototype-key safety pattern. Do not
  reparse the lock loosely inside shell. CLI output may print names, versions,
  CIDs, ports, and digests, but never repository credentials or runtime keys.

- [x] **Step 5: Verify**

  ```sh
  npm --prefix tools run typecheck
  npm --prefix tools test -- --test-name-pattern='runtime lock'
  npm --prefix tools run cli -- runtime lock verify
  just test-unit
  git diff --check
  ```

- [x] **Step 6: Independent task review and ledger**

  Review schema completeness, digest/platform correctness, unsafe YAML forms,
  floating inputs, and CLI disclosure. Fix every finding with a regression,
  then append exact refs and command results to the goal ledger.

## Task 2: Pinned Curio image build

**Owns:**

- Create: `docker/curio-all-in-one.Dockerfile`
- Create: `scripts/devnet-common.sh`
- Create: `scripts/devnet-build.sh`
- Create/modify: `tools/test/devnet.test.ts`
- Modify: `justfile`, `README.md`, `scripts/static-checks.sh`

**Produces:**

- namespaced local images labelled with the exact Curio and Lotus commits;
- `just build`;
- `.runtime/devnet/build/images.json` with image IDs, architecture, source
  commits, Dockerfile hash, start/end time, and build duration

- [x] **Step 1: Write failing build/static tests**

  Assert the tracked Dockerfile and build script:

  - contain no `latest`, `@master`, `@main`, `foundryup`, NodeSource setup, or
    unchecked remote clone;
  - use lock-derived immutable base references;
  - use exact 40-character revisions for `go-car`, piece-server,
    storetheindex, and geth;
  - build from the exact managed Curio path and reject dirty/mismatched source;
  - never run `git submodule update` inside the image;
  - use `CURIO_TAGS="cunative debug nosupraseal"` and the compatible pinned
    Lotus DevNet image;
  - label the image with exact source commits.

- [x] **Step 2: Run RED**

  ```sh
  npm --prefix tools test -- --test-name-pattern='devnet build'
  ```

- [x] **Step 3: Implement the transparent Dockerfile**

  Reproduce only the required upstream build graph:

  - Lotus binaries copied from the immutable Lotus DevNet image;
  - Curio and `sptool` built from the managed Curio context;
  - exact managed `filecoin-ffi` content already present in the context;
  - exact-revision Go tools;
  - immutable Node and Foundry binaries;
  - runtime packages required by the upstream entrypoints.

  Do not patch Curio source during the build. Copy the selected pinned
  checkout's upstream service entrypoints through each small service
  Dockerfile or build the service images using those upstream Dockerfiles with
  the namespaced exact base image.

- [x] **Step 4: Implement bounded build orchestration**

  `scripts/devnet-build.sh` must:

  1. run source and runtime-lock verification;
  2. check Docker/BuildKit and supported architecture;
  3. validate manifest-to-platform digest resolution;
  4. build the all-in-one base and six derived Curio service images;
  5. tag only under `porep-market-curio-devnet/*:<curio-short-commit>`;
  6. inspect labels, image IDs, OS, and architecture;
  7. atomically write the public image manifest.

  Bound the complete build to 90 minutes. On failure, retain BuildKit output
  under `.runtime/devnet/logs/` and do not remove caches or unrelated images.

- [x] **Step 5: Verify without starting services**

  ```sh
  just build
  docker image inspect <each namespaced image>
  just build
  just test-unit
  git diff --check
  ```

  The second build must be safe and reuse cache. Record timings and image IDs.

- [x] **Step 6: Independent task review and ledger**

  Review supply-chain pins, context confinement, secret leakage, tags/labels,
  architecture, timeouts, and failure cleanup. Fix all findings before Task 3.

## Task 3: Project-owned Compose and safe lifecycle

**Owns:**

- Create: `docker/compose.curio-devnet.yaml`
- Create: `scripts/devnet-up.sh`
- Create: `scripts/devnet-down.sh`
- Create: `scripts/devnet-reset.sh`
- Create: `scripts/devnet-logs.sh`
- Modify: `scripts/devnet-common.sh`
- Modify: `tools/src/devnet.ts`, `tools/test/devnet.test.ts`
- Modify: `.env.example`, `.gitignore`, `justfile`, README

**Produces:**

- `just up`, `just down`, `just reset`, `just logs [service]`;
- rendered Compose validation;
- exact runtime ownership markers under `.runtime/devnet/`

- [x] **Step 1: Write failing Compose/lifecycle tests**

  Prove rendered Compose:

  - has exactly the seven expected services;
  - has no `container_name`, top-level fixed `name`, static subnet, static IP,
    anonymous volume, source-cache write mount, host-home mount, or Boost port;
  - uses only namespaced built images plus immutable Yugabyte;
  - binds only `.runtime/devnet/data/*`, `.cache/proof-parameters`, and
    read-only exact managed contract sources;
  - uses local Filecoin Services and Multicall sources;
  - disables floating Synapse SDK bootstrap with a created marker;
  - exposes Filecoin RPC 2234, miner API 22345, Curio API 22300, Market 22310,
    UI 24701, piece server 22320, database ports 25433/29042/25434, and
    indexer ports 23000-23003 unless live collision checks require a documented
    coherent change;
  - preserves NV27 genesis and FireHorse epoch 200 variables.

  Prove scripts reject:

  - empty, `/`, home, repository root, symlinked, or outside-repository reset
    paths;
  - project names other than the exact allowlisted project;
  - service log names outside the seven-service allowlist;
  - `down -v`, `--rmi`, `docker system prune`, broad container/volume filters,
    and upstream Make lifecycle targets.

- [x] **Step 2: Run RED**

  ```sh
  npm --prefix tools test -- --test-name-pattern='compose|lifecycle'
  ```

- [x] **Step 3: Implement Compose**

  Keep upstream environment and volume contracts needed by the real
  entrypoints, with these deliberate changes:

  - project-derived resource names;
  - non-colliding host ports;
  - runtime-owned bind mounts;
  - local pinned contract-source mounts;
  - immutable images;
  - explicit NV schedule;
  - `init: true`, bounded restart policy, logging limits;
  - useful healthchecks where a stable local probe exists.

  Do not claim healthchecks alone prove readiness.

- [x] **Step 4: Implement lifecycle**

  - `up`: validate images/lock/ports/paths, create exact runtime directories
    and Synapse-disabled marker, then `docker compose up -d`; never delete.
  - `down`: `docker compose down` without `-v`, `--rmi`, or state removal.
  - `logs`: allowlisted service or complete project logs, bounded lines/since.
  - `reset`: validate exact ownership marker and realpaths, capture final logs,
    run exact-project `down --volumes --remove-orphans`, move the current
    `.runtime/devnet/data` and runtime manifests to a timestamped
    `.runtime/verification-backups/` path rather than deleting, then recreate
    empty project state. Preserve proof parameters and build cache.

- [x] **Step 5: Static verification**

  ```sh
  docker compose -p porep-market-curio-devnet \
    -f docker/compose.curio-devnet.yaml config
  npm --prefix tools run typecheck
  npm --prefix tools test -- --test-name-pattern='compose|lifecycle'
  bash -n scripts/devnet-*.sh
  just test-unit
  git diff --check
  ```

- [x] **Step 6: Independent task review and ledger**

  Review Docker resource scope, reset target proof, mounts, permissions,
  secret handling, unrelated Boost isolation, ports, and bounded operations.

## Task 4: Semantic status and bounded diagnostics

**Owns:**

- Create/modify: `tools/src/devnet.ts`
- Create/modify: `tools/test/devnet.test.ts`
- Create: `scripts/devnet-status.sh`
- Modify: `scripts/devnet-common.sh`, `justfile`, README

**Produces:**

- `just status`;
- `.runtime/devnet/status/latest.json`;
- failure diagnostics under `.runtime/devnet/logs/<timestamp>/`

- [x] **Step 1: Write failing status tests**

  Use fixture JSON/command adapters to prove parsing and rejection for:

  - Compose service state/health;
  - Lotus version and chain head;
  - Ethereum `eth_chainId == 0x1df5e76` (`31415926`);
  - network version and epoch;
  - actor v18 manifest/required miner code after epoch 200;
  - miner/provider actor discovery without assuming `t01000`;
  - owner, worker, and control addresses;
  - Curio version/commit and API readiness;
  - Market 2.0 endpoint readiness;
  - HarmonyDB/Yugabyte readiness and current Curio task visibility;
  - 8 MiB sector proof/fast-sealing configuration;
  - stale runtime generation or missing build manifest;
  - timeout reports containing last public state and log paths.

- [x] **Step 2: Run RED**

  ```sh
  npm --prefix tools test -- --test-name-pattern='devnet status'
  ```

- [x] **Step 3: Implement semantic probes**

  Use `docker compose exec -T` for bundled `lotus`, `lotus-miner`, `curio`,
  `sptool`, database, and shell tools. Use host HTTP/JSON-RPC only for the
  documented public endpoints. Discover the non-genesis Curio provider actor
  from live Curio config/chain state; do not hard-code `t01000`.

  Status waits:

  - individual probe at most 30 seconds;
  - startup convergence at most 20 minutes;
  - NV28 convergence at most 15 minutes after service readiness;
  - poll intervals 1-5 seconds;
  - external subprocesses through the bounded runner.

- [x] **Step 4: Implement diagnostic capture**

  On failure record the last public readiness state plus bounded Compose `ps`
  and service log tails under one timestamped diagnostic directory. Add more
  probes only when a real failure cannot be diagnosed from that evidence.

  Never copy or print private-key files, tokens, environment dumps, or full
  contract env files.

- [x] **Step 5: Verify fixtures and public command**

  ```sh
  npm --prefix tools run typecheck
  npm --prefix tools test -- --test-name-pattern='devnet status'
  just test-unit
  just status
  ```

  Before live startup, `just status` must fail boundedly with a precise
  not-running diagnosis.

- [x] **Step 6: Focused task review and ledger**

  Under Lean Execution Mode, review false-positive readiness, actor discovery,
  JSON parsing, timeout behavior, and diagnostics in the main thread. Do not
  create a separate reviewer solely for this local status script.

## Task 5: Live lifecycle, persistence, reset, and measured proof

**Owns:**

- Create: `docs/runtime/curio-devnet.md`
- Modify: `README.md`
- Modify: goal checklist/ledger and `.superpowers/sdd/progress.md`
- Runtime evidence only under `.runtime/devnet/`

**Produces:** Complete Phase 2 runtime evidence.

- [x] **Step 1: Preflight exact destructive scope**

  Record:

  - current Docker projects/containers/networks/volumes and occupied ports;
  - active unrelated Boost project resources;
  - exact project/runtime realpaths and ownership markers;
  - available CPU, Docker memory, disk, architecture;
  - image manifest/platform resolution;
  - current managed source verification.

  Do not stop or modify unrelated resources. If host ports collide, update only
  this project's public defaults coherently and rerun Task 3 review.

- [x] **Step 2: Clean bootstrap and build**

  From verified sources:

  ```sh
  just bootstrap
  just build
  ```

  Record start/end/duration, image IDs, platform, disk delta, and peak/steady
  Docker resource usage where measurable.

- [x] **Step 3: First standalone start**

  Run:

  ```sh
  just up
  just status
  ```

  Prove:

  - exact seven-service project state;
  - FEVM JSON-RPC and chain ID;
  - Lotus/Curio versions and commits;
  - NV27 genesis schedule and live NV28/actors v18 after epoch 200;
  - provider actor ID plus owner/worker/control addresses;
  - Curio API, GUI, Market 2.0, database/tasks, piece server, and indexer;
  - 8 MiB fast-sealing configuration;
  - no Phase 3 deployment manifest exists or is reused.

  Capture bounded diagnostics on the first failure. Do not reset/retry without
  a falsifiable correction.

- [x] **Step 4: Non-destructive persistence proof**

  Snapshot chain head/genesis CID, provider actor, Curio cluster/storage
  identity, selected marker/file hashes, and database identity. Run:

  ```sh
  just down
  just up
  just status
  ```

  Prove the same genesis/provider/runtime state resumed and the head advanced.

- [x] **Step 5: Destructive project-only reset proof**

  Capture unrelated Boost resource IDs before reset. Run:

  ```sh
  just reset
  just up
  just status
  ```

  Prove:

  - only this project's state generation changed;
  - a new genesis/provider/runtime identity was created as expected;
  - old runtime/deployment manifests are invalidated/preserved outside the
    active path;
  - every unrelated Boost resource ID/state is unchanged;
  - proof/build caches remain;
  - the new chain again reaches NV28.

- [x] **Step 6: Document measured standalone use**

  `docs/runtime/curio-devnet.md` and README must include:

  - exact endpoints and project-derived container names;
  - chain ID and runtime provider discovery command;
  - `lotus`, `lotus-miner`, `curio`, `sptool`, and `cast` access through
    Compose;
  - state, image manifest, status, and log paths;
  - non-destructive versus reset behavior;
  - measured first build/start/NV28, restart, reset timings;
  - observed CPU/RAM/disk and host architecture;
  - test-only secret warning;
  - current boundary: PoRep Market deployment/E2E remains Phase 3+.

- [x] **Step 7: Phase 2 whole-change gate**

  Generate a complete Phase 2 production diff excluding generated review
  artifacts. Run exactly one `gate-review` workflow covering:

  - supply-chain/image pinning;
  - Dockerfile/context safety;
  - Compose resource isolation;
  - reset/down safety;
  - secret handling;
  - readiness truthfulness;
  - bounded processes/polls and diagnostics;
  - NV27/NV28 evidence;
  - persistence/reset claims.

  Fix every Critical/Warning with a regression, prove the correction in the
  main thread, and rerun the affected live proof. Do not start a reviewer loop
  for a concrete local-script correction.

- [x] **Step 8: Close Phase 2**

  Check the seven Phase 2 goal items only after every independent gate finding
  is closed with current evidence and all live evidence remains current. Update
  the ledger with exact commands, exits, IDs, timings, resource measurements,
  and evidence paths. Mark Phase 2 complete and create the Phase 3 plan.

## Phase 2 completion gate

Phase 2 is not complete until all are true:

- immutable build/runtime inputs are typed and verified;
- Curio images build from the exact managed checkout on this host;
- Compose uses unique project-derived resources and no upstream destructive
  lifecycle;
- `up` is non-destructive, `down -> up` preserves state, and `reset` changes
  only this project's state;
- Lotus/Curio/database/Market/provider readiness is proven semantically;
- the live chain reaches NV28 with actors v18 at epoch 200;
- all commands/polls are bounded and preserve useful diagnostics;
- unrelated Boost resources remain unchanged;
- measured standalone usage is documented;
- every Critical and Warning from the single Phase 2 gate review is closed by
  regression and current runtime evidence.
