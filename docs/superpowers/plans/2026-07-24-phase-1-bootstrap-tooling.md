# Phase 1 Bootstrap Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the repository scaffold, lockfile parser, exact-commit source fetcher, public `just` command surface, and static/unit safety gates, then prove `just bootstrap` from an empty managed cache.

**Architecture:** A small TypeScript tooling package under `tools/` parses and validates `versions.lock.yaml` and owns managed Git checkouts. Root `just` recipes call stable scripts and reserve destructive behavior for explicit reset commands. The future Curio runtime, contract deployment, and migrated E2E package consume the same validated lock but are not implemented in this phase.

**Tech Stack:** Node.js 24.14.0 (minimum 20), TypeScript, `tsx`, Node test runner, `yaml`, shellcheck, just 1.46+, Git, Docker Compose.

## Global Constraints

- Never read a sibling source checkout in the default workflow.
- Managed sources live only at `.cache/sources/<lock-key>/<commit>/`.
- Runtime state, identities, manifests, and logs live only under `.runtime/`.
- Fetch exact commits in detached HEAD state and reject dirty or mismatched managed checkouts.
- Public commands never print secrets.
- `just up` and `just down` are non-destructive; only `just reset` may remove this project's named state.
- Every external process has a bounded timeout and reports the command and last useful state.
- Git staging, commits, pushes, rebases, and GitHub writes are forbidden by `../AGENTS.md`; replace plan commit checkpoints with goal-ledger evidence rows.

---

## Planned file structure

- `.gitignore`: excludes managed sources, runtime state, dependencies, build outputs, keys, and local environment files.
- `.env.example`: documents only public, non-secret overrides.
- `README.md`: root lifecycle, host requirements, paths, and current phase capability.
- `justfile`: stable public lifecycle and verification recipes.
- `tools/package.json`, `tools/package-lock.json`, `tools/tsconfig.json`: isolated tooling dependency boundary.
- `tools/src/lock.ts`: lockfile types, validation, and normalized source records.
- `tools/src/process.ts`: bounded subprocess execution with structured failures.
- `tools/src/sources.ts`: exact-commit managed checkout reconciliation.
- `tools/src/cli.ts`: `lock verify`, `sources fetch`, and `sources verify` entry points.
- `tools/test/lock.test.ts`: valid/invalid lock parsing.
- `tools/test/process.test.ts`: timeout and exit diagnostics.
- `tools/test/sources.test.ts`: idempotency, detached HEAD, mismatch, and dirty-checkout behavior using local fixture repositories.
- `scripts/bootstrap.sh`: installs the locked tooling package and invokes source reconciliation.
- `scripts/static-checks.sh`: shell syntax, recipe, ignored-path, secret-pattern, and absolute-path checks.

### Task 1: Repository safety scaffold and public command contract

**Files:**

- Create: `.gitignore`
- Create: `.env.example`
- Create: `README.md`
- Create: `justfile`
- Create: `scripts/static-checks.sh`
- Test: command inspection plus `just --list`

**Interfaces:**

- Consumes: `versions.lock.yaml`, ADR 0001, and the root goal.
- Produces: root recipes `bootstrap`, `build`, `up`, `status`, `deploy`, `addresses`, `test-unit`, `test-scenario`, `test-e2e`, `test-all`, `logs`, `down`, and `reset`.

- [x] **Step 1: Write the initial static check before the files it validates exist**

Create `scripts/static-checks.sh` with strict shell mode and checks for:

```bash
required=(bootstrap build up status deploy addresses test-unit test-scenario test-e2e test-all logs down reset)
for recipe in "${required[@]}"; do
  just --summary | tr ' ' '\n' | grep -Fx "$recipe" >/dev/null ||
    { echo "missing public recipe: $recipe" >&2; exit 1; }
done

git check-ignore -q .cache/sources/example/deadbeef
git check-ignore -q .runtime/deployments/example.json
git check-ignore -q tools/node_modules/example
git check-ignore -q .env
```

Add a repository text scan that excludes `.git`, `.cache`, `.runtime`,
`node_modules`, `docs/goals`, and this implementation plan, and fails on
absolute `/Users/` paths, `CURIO_DIR`, private-key assignments, or unbounded
`while true` loops in tracked implementation files.

- [x] **Step 2: Run the check and verify the scaffold is missing**

Run: `bash scripts/static-checks.sh`

Expected: nonzero with the first missing public recipe or ignore rule.

- [x] **Step 3: Add ignore and environment contracts**

`.gitignore` must contain:

```gitignore
.cache/
.runtime/
node_modules/
tools/node_modules/
tools/dist/
.env
.env.*
!.env.example
*.key
*.pem
```

`.env.example` must define only public overrides with safe defaults:

```dotenv
COMPOSE_PROJECT_NAME=porep-market-curio-devnet
FILECOIN_RPC_URL=http://127.0.0.1:2234/rpc/v1
CURIO_MARKET_URL=http://127.0.0.1:22310
CURIO_API_URL=http://127.0.0.1:22300
CURIO_UI_URL=http://127.0.0.1:24701
```

- [x] **Step 4: Add the stable recipe surface**

Create a `justfile` that imports `.env` only when present, defines the exact
public recipes above, delegates `bootstrap` to `scripts/bootstrap.sh`, delegates
`test-unit` to the tooling package plus `scripts/static-checks.sh`, and makes
unimplemented later-phase recipes fail with:

```text
<recipe> is not implemented yet; see docs/goals/2026-07-24-complete-porep-market-curio-devnet.md
```

No recipe may silently succeed before it has evidence.

- [x] **Step 5: Document the current colleague workflow**

README sections must cover architecture, exact source/cache/runtime ownership,
host prerequisites, `just --list`, `just bootstrap`, `just test-unit`, public
endpoint defaults, non-destructive versus destructive commands, diagnostics,
and the explicit statement that live DevNet/deployment/E2E recipes remain
unavailable until their verification phases pass.

- [x] **Step 6: Verify scaffold behavior**

Run:

```bash
bash -n scripts/static-checks.sh
just --list
bash scripts/static-checks.sh
git check-ignore -v .cache/sources/example/deadbeef .runtime/deployments/example.json tools/node_modules/example .env
```

Expected: every command exits 0 and `just --list` exposes every required public recipe.

- [x] **Step 7: Record the checkpoint**

Append a Phase 1 row to the goal Progress Ledger with the exact command outputs.
Do not stage or commit.

### Task 2: Typed lockfile and bounded process runner

**Files:**

- Create: `tools/package.json`
- Create: `tools/package-lock.json`
- Create: `tools/tsconfig.json`
- Create: `tools/src/lock.ts`
- Create: `tools/src/process.ts`
- Create: `tools/test/lock.test.ts`
- Create: `tools/test/process.test.ts`

**Interfaces:**

- Produces: `loadVersionLock(path: string): VersionLock`,
  `managedSources(lock: VersionLock): ManagedSource[]`, and
  `run(command: string, args: string[], options: RunOptions): Promise<RunResult>`.
- `ManagedSource` contains `name`, `repository`, `commit`, and `submodules`.
- `RunOptions` requires `cwd` and `timeoutMs`; `RunResult` contains `stdout`,
  `stderr`, `exitCode`, and `durationMs`.

- [x] **Step 1: Write lock validation tests**

Tests must prove that the checked-in lock loads eight source records and reject:

```ts
{ schema_version: 2, sources: {} }
{ schema_version: 1, sources: { curio: { repository: "", commit: "abc" } } }
{ schema_version: 1, sources: { curio: { repository: "https://example.test/x.git", commit: "main" } } }
```

The last case must fail because commits are exactly 40 lowercase hexadecimal
characters.

- [x] **Step 2: Write process tests**

Use `process.execPath` as the fixture executable. Prove successful output,
nonzero exit capture, and forced timeout of a child that schedules a ten-second
timer. The timeout must terminate the process and include `timed out after
100ms` in the thrown error.

- [x] **Step 3: Run tests and verify missing modules**

Run: `npm --prefix tools test`

Expected: nonzero because `lock.ts` and `process.ts` do not exist.

- [x] **Step 4: Implement the minimal lock parser**

Pin `typescript@7.0.2`, `tsx@4.23.1`, `yaml@2.9.0`, and
`@types/node@26.1.1` in `tools/package.json`; `package-lock.json` must be
generated by npm and committed to the filesystem even though Git commits are
forbidden.

Use `yaml.parse`, explicit record guards, and exact commit validation. Reject
unknown schema versions, absent source maps, empty repositories, non-HTTPS
checked-in repositories, and duplicate `(repository, commit)` output paths.
Keep test-only parsing able to accept an explicit `allowLocalRepositories`
option for local Git fixtures.

- [x] **Step 5: Implement bounded process execution**

Use `spawn` with `shell: false`, capture stdout/stderr, start a timer from the
required `timeoutMs`, send `SIGTERM` on expiry, then `SIGKILL` after a bounded
one-second grace period. Error text must include quoted executable/arguments,
cwd, timeout or exit code, and bounded trailing stderr.

- [x] **Step 6: Verify type and unit gates**

Run:

```bash
npm ci --prefix tools
npm --prefix tools run typecheck
npm --prefix tools test
```

Expected: all commands exit 0; tests include lock rejection and process timeout.

- [x] **Step 7: Record the checkpoint**

Append test counts and exit codes to the goal Progress Ledger. Do not stage or commit.

### Task 3: Exact-commit managed source fetcher

**Files:**

- Create: `tools/src/sources.ts`
- Create: `tools/src/cli.ts`
- Create: `tools/test/sources.test.ts`
- Modify: `tools/package.json`

**Interfaces:**

- Consumes: `ManagedSource`, `run`, repository root, and `.cache/sources`.
- Produces:
  - `reconcileSource(source, cacheRoot): Promise<SourceState>`
  - `verifySource(source, cacheRoot): Promise<SourceState>`
  - CLI: `lock verify`, `sources fetch`, `sources verify`
- `SourceState` contains source name, path, expected commit, actual commit,
  detached status, dirty status, and verified submodule commits.

- [x] **Step 1: Write local-repository fixture tests**

Create temporary local origin repositories with two commits and prove:

1. the first reconcile checks out the requested commit detached;
2. a second reconcile makes no source changes;
3. an unexpected HEAD fails verification;
4. an untracked file fails as dirty;
5. a modified tracked file fails as dirty;
6. a missing expected commit fails with the source name and commit;
7. a declared submodule is initialized at the recorded commit.

- [x] **Step 2: Run the focused tests and verify failure**

Run: `npm --prefix tools test -- --test-name-pattern='source'`

Expected: nonzero because `sources.ts` does not exist.

- [x] **Step 3: Implement exact detached checkout reconciliation**

For a missing checkout:

```text
git init <destination>
git -C <destination> remote add origin <repository>
git -C <destination> fetch --depth 1 origin <commit>
git -C <destination> checkout --detach FETCH_HEAD
git -C <destination> submodule update --init --recursive
```

For an existing checkout, never clean, reset, stash, or overwrite. Verify
origin URL, `HEAD`, detached status, recursive submodule status, and
`git status --porcelain=v1 --untracked-files=all`. Reject any mismatch with a
precise recoverable instruction naming only the managed checkout path.

- [x] **Step 4: Add the CLI**

The CLI resolves repository root from its own module location, defaults to
`versions.lock.yaml`, never accepts sibling-source overrides, prints one
tab-separated public status row per source, and returns nonzero on the first
unsafe state.

- [x] **Step 5: Verify the focused and full tool suite**

Run:

```bash
npm --prefix tools run typecheck
npm --prefix tools test
npm --prefix tools run cli -- lock verify
```

Expected: all commands exit 0 and `lock verify` reports eight exact source records.

- [x] **Step 6: Record the checkpoint**

Append source test count, lock summary, and exit codes to the goal ledger. Do not stage or commit.

### Task 4: Bootstrap integration and empty-cache proof

**Files:**

- Create: `scripts/bootstrap.sh`
- Modify: `justfile`
- Modify: `README.md`
- Modify: `docs/goals/2026-07-24-complete-porep-market-curio-devnet.md`

**Interfaces:**

- Consumes: locked tooling package and source fetcher.
- Produces: `just bootstrap`, `just test-unit`, and verified detached checkouts
  under `.cache/sources`.

- [x] **Step 1: Write bootstrap orchestration**

`scripts/bootstrap.sh` must:

1. resolve the repository root without using the caller's cwd;
2. require Node 20+, npm, Git, and `just`;
3. run `npm ci --prefix tools`;
4. run `lock verify`;
5. run `sources fetch`;
6. run `sources verify`;
7. print only source names, commits, and managed paths.

The script must use strict shell mode, a fixed `PATH` inherited from the user,
and no credential or environment dumps.

- [x] **Step 2: Verify shell and unit gates before network work**

Run:

```bash
bash -n scripts/bootstrap.sh scripts/static-checks.sh
just test-unit
```

Expected: exit 0.

- [x] **Step 3: Prepare the destructive verification target safely**

Confirm `.cache/sources` resolves under this repository and contains only
fetcher-managed directories. Move an existing cache, if any, to a timestamped
`.runtime/verification-backups/` path instead of deleting user data. Record
the exact backup path in the ledger.

- [x] **Step 4: Run the empty-cache proof**

Run with a declared 30-minute timeout:

```bash
just bootstrap
```

Expected: exit 0; all eight sources exist at
`.cache/sources/<name>/<commit>/`, every HEAD equals the lock, every checkout
is detached and clean, and recursive submodules match recorded commits.

- [x] **Step 5: Prove idempotency**

Record the source HEADs and directory mtimes, rerun `just bootstrap`, and run
`sources verify`.

Expected: exit 0; HEADs remain identical, no checkout becomes dirty, and no
source is fetched from a sibling path.

- [x] **Step 6: Run the Phase 1 gate**

Run:

```bash
just test-unit
npm --prefix tools run cli -- sources verify
git status --short --branch
git diff --check
```

Expected: all verification commands exit 0. Git status contains only intended
tracked-project additions and no `.cache`, `.runtime`, dependency, key, or
environment artifacts.

- [x] **Step 7: Close Phase 1**

Check every proven Phase 1 goal item, append exact commands, exit codes,
source commits, timings, and paths to the Progress Ledger, then re-read the
goal before Phase 2. Do not stage or commit.
