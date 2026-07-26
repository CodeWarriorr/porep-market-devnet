# Phase 1 gate-review verification

Verdict: `NEEDS_REWORK`.

The independent Verifier / Synthesizer read the actual code, reproduced each
serious candidate in controlled temporary paths/processes, sought
counterexamples, and deduplicated the two overlapping scout reports. All
confirmed findings are introduced by the new Phase 1 files.

## Confirmed findings

### CRITICAL: inherited Git environment bypasses managed-cache confinement

`tools/src/process.ts` inherits the complete process environment, and every Git
call in `tools/src/sources.ts` uses it. A controlled `reconcileSource()` call
with `GIT_DIR` pointing at a temporary external path created the Git repository
outside the managed destination. The existing path and symlink checks do not
constrain Git's environment-selected repository.

Real path: `just bootstrap` -> CLI `sources fetch` -> `reconcileSource()` ->
Git initialization/fetch.

### WARNING: external cancellation leaves public command children running

`scripts/run-with-timeout.mjs` creates a detached child process group but only
signals it from the internal timeout. A controlled SIGTERM caused the helper to
exit 143 while its detached child remained alive. This affects Ctrl-C and CI
cancellation of `just bootstrap` and `just test-unit`.

### WARNING: per-command timeout kills only the direct Git process

`tools/src/process.ts` signals only the direct child PID. A controlled
grandchild wrote a marker after `run()` had already rejected on timeout.
Recursive Git/submodule descendants can therefore continue modifying a
checkout beyond the declared per-Git timeout.

### WARNING: public unit gate omits typechecking

`just test-unit` runs npm tests and static checks but not the separately defined
`tsc --noEmit` script. The current direct typecheck passes, but that does not
make the documented public static/type/unit entry point complete.

### WARNING: claimed Node 20 support excludes real Node 20 releases

Bootstrap accepts all Node 20 releases, while `import.meta.dirname` in the CLI
and tests requires Node 20.11+. The code must use the older compatible
`fileURLToPath(import.meta.url)` pattern or narrow the documented and enforced
minimum.

### WARNING: npm registry tokens bypass the secret gate

`.npmrc` is not ignored, and the static scan does not recognize npm
`_authToken` assignments. A controlled developer-local `.npmrc` path was
unignored and its token line did not match the scanner.

### WARNING: timeout helper ignores output backpressure

The helper keeps reading child output when writes to its own stdout/stderr
return `false`. With an unread downstream pipe and 64 MiB child output, the
verifier measured helper RSS at 117,696 KiB, demonstrating queued output growth.

## Retraction

The proposed future submodule-transport finding is retracted as a current
defect. The verifier and Security Scout found HTTPS URLs in all 49 reachable
pinned recursive `.gitmodules` files. A future lock change should re-run that
audit, but no current source pin reaches another transport.

## Verification commands

- `npm --prefix tools run typecheck`: exit 0.
- `npm --prefix tools test`: 40/40 pass.
- `just test-unit`: exit 0, confirming it currently misses the separate
  typecheck.
- Current eight-source verification, shell syntax, and `git diff --check`:
  exit 0.
- Temporary probes were cleaned and no probe process remained.

The corrected final-lock empty-cache bootstrap was not repeated during this
read-only verification because the verifier's packet prohibited network
fetches. Its existing evidence remains valid but does not waive these findings.

## Final continuation verification

Verdict: `READY_TO_MERGE`.

The fixes added regression coverage and closed every confirmed finding:

- Git subprocesses discard inherited repository/work-tree/index/config
  controls and use isolated system/global/local configuration handling.
- Root and recursive Git configs reject executable includes/hooks and unsafe
  keys before any managed-checkout Git operation.
- Recursive submodule `.git` files, `.git/modules` gitdirs, config mappings,
  and `core.worktree` realpaths must map one-to-one to the exact locked
  submodule worktrees. The former clean in-root shadow-worktree exploit now
  fails.
- Reusable and public timeout runners terminate process groups, forward
  external cancellation, settle boundedly, and bound output under backpressure.
- `just test-unit` includes typecheck; Node 20 execution no longer depends on
  newer `import.meta` helpers; `.npmrc` and `.netrc` credential forms are
  ignored and statically rejected.

The independent verifier checked patch
`da22c63b1b84117d3d5ed492b7a0c14580ea3c47339b36c7ba13f8152f1e1989`
(4,273 lines, 169,543 bytes), reproduced the former nested
`core.worktree` bypass, exercised direct `core.fsmonitor`, `include.path`,
nested-config, root-`core.worktree`, missing/duplicate/unexpected mapping, and
realpath-alias cases, and confirmed no marker hook executed.

Final continuation commands all exited 0:

- `npm --prefix tools run typecheck`
- `npm --prefix tools test` (verifier run: 60/60)
- focused security suite (4/4)
- `npm --prefix tools run cli -- sources verify` (all eight exact sources)
- `bash scripts/static-checks.sh`
- shell syntax checks
- `git diff --check`

No Critical or Warning finding remains. A new empty-cache network bootstrap was
outside the read-only verifier packet and remains a separate Phase 1 closure
gate.

## Network-timeout continuation verification

Verdict: `READY_TO_MERGE`.

The first reviewed-code empty-cache closure attempt exposed one additional
bounded-runtime defect: the clean PoRep Market recursive submodule clone was
still progressing when the shared 60-second Git timeout terminated it. The
outer bootstrap failed after 152 seconds and preserved its partial cache.

The production delta separates the timeout contracts:

- `SOURCE_FETCH_GIT_TIMEOUT_MS = 600_000` for source creation `init`,
  `remote add`, `fetch`, `checkout`, and recursive submodule update calls;
- `SOURCE_INSPECTION_GIT_TIMEOUT_MS = 60_000` for config parsing and every
  read-only source verification call;
- the complete `sources fetch` process remains bounded at 1,200 seconds.

The independent verifier checked complete patch
`90895def849307f63a8861cd3bc5315242527817f96d1acc4addb46268186134`
(4,290 lines, 170,139 bytes), manually inspected every timeout call site, and
returned zero Critical and zero Warning findings. Typecheck, static checks,
`git diff --check`, and the full 63/63 suite passed. The verifier did not mutate
or repair the intentionally partial cache and did not perform a network fetch.
