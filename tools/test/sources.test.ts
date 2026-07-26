import assert from "node:assert/strict";
import { access, chmod, lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ManagedSource } from "../src/lock.js";
import {
  SOURCE_FETCH_GIT_TIMEOUT_MS,
  SOURCE_INSPECTION_GIT_TIMEOUT_MS,
  reconcileSource,
  verifySource,
} from "../src/sources.js";

test("source fetch Git operations have a bounded network allowance above local inspection", () => {
  assert.equal(SOURCE_INSPECTION_GIT_TIMEOUT_MS, 60_000);
  assert.equal(SOURCE_FETCH_GIT_TIMEOUT_MS, 600_000);
  assert.ok(SOURCE_FETCH_GIT_TIMEOUT_MS > SOURCE_INSPECTION_GIT_TIMEOUT_MS);
  assert.ok(SOURCE_FETCH_GIT_TIMEOUT_MS < 1_200_000);
});

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const { run } = await import("../src/process.js");
  await run("git", args, { cwd, timeoutMs: 10_000 });
};

const gitOutput = async (cwd: string, ...args: string[]): Promise<string> => {
  const { run } = await import("../src/process.js");
  return (await run("git", args, { cwd, timeoutMs: 10_000 })).stdout.trim();
};

interface Fixture {
  cacheRoot: string;
  source: ManagedSource;
  firstCommit: string;
  checkoutPath: string;
  cleanup(): Promise<void>;
}

async function createFixture(options: { nestedSubmodule?: boolean; submodule?: boolean } = {}): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "porep-sources-"));
  const origin = join(directory, "origin.git");
  const worktree = join(directory, "worktree");
  const cacheRoot = join(directory, "cache");
  await git(directory, "init", "--bare", origin);
  await git(directory, "clone", origin, worktree);
  await git(worktree, "config", "user.name", "Source fixture");
  await git(worktree, "config", "user.email", "source-fixture@example.test");

  const submodules: Record<string, string> = {};
  if (options.submodule) {
    const childOrigin = join(directory, "child.git");
    const childWorktree = join(directory, "child-worktree");
    await git(directory, "init", "--bare", childOrigin);
    await git(directory, "clone", childOrigin, childWorktree);
    await git(childWorktree, "config", "user.name", "Source fixture");
    await git(childWorktree, "config", "user.email", "source-fixture@example.test");
    await writeFile(join(childWorktree, "child.txt"), "child\n");
    await git(childWorktree, "add", "child.txt");
    await git(childWorktree, "commit", "-m", "child");
    if (options.nestedSubmodule) {
      const grandchildOrigin = join(directory, "grandchild.git");
      const grandchildWorktree = join(directory, "grandchild-worktree");
      await git(directory, "init", "--bare", grandchildOrigin);
      await git(directory, "clone", grandchildOrigin, grandchildWorktree);
      await git(grandchildWorktree, "config", "user.name", "Source fixture");
      await git(grandchildWorktree, "config", "user.email", "source-fixture@example.test");
      await writeFile(join(grandchildWorktree, "grandchild.txt"), "grandchild\n");
      await git(grandchildWorktree, "add", "grandchild.txt");
      await git(grandchildWorktree, "commit", "-m", "grandchild");
      await git(grandchildWorktree, "push", "origin", "HEAD");
      submodules["child/grandchild"] = await gitOutput(grandchildWorktree, "rev-parse", "HEAD");
      await git(childWorktree, "-c", "protocol.file.allow=always", "submodule", "add", grandchildOrigin, "grandchild");
      await git(childWorktree, "commit", "-m", "nested submodule");
    }
    await git(childWorktree, "push", "origin", "HEAD");
    submodules.child = await gitOutput(childWorktree, "rev-parse", "HEAD");
    await git(worktree, "-c", "protocol.file.allow=always", "submodule", "add", childOrigin, "child");
  }

  await writeFile(join(worktree, "tracked.txt"), "first\n");
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-m", "first");
  const firstCommit = await gitOutput(worktree, "rev-parse", "HEAD");
  await git(worktree, "push", "origin", "HEAD");
  await writeFile(join(worktree, "tracked.txt"), "second\n");
  await git(worktree, "commit", "-am", "second");
  await git(worktree, "push", "origin", "HEAD");

  return {
    cacheRoot,
    firstCommit,
    checkoutPath: join(cacheRoot, "fixture", firstCommit),
    source: { name: "fixture", repository: origin, commit: firstCommit, submodules },
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}

async function createFsmonitorHook(fixture: Fixture, name: string): Promise<{ hookPath: string; markerPath: string }> {
  const fixtureRoot = join(fixture.cacheRoot, "..");
  const hookPath = join(fixtureRoot, `${name}-fsmonitor`);
  const markerPath = join(fixtureRoot, `${name}-fsmonitor-ran`);
  await writeFile(hookPath, `#!/bin/sh\nprintf executed > ${JSON.stringify(markerPath)}\n`);
  await chmod(hookPath, 0o755);
  return { hookPath, markerPath };
}

test("source reconcile checks out the requested commit detached", async () => {
  const fixture = await createFixture();
  try {
    const state = await reconcileSource(fixture.source, fixture.cacheRoot);
    assert.equal(state.actualCommit, fixture.firstCommit);
    assert.equal(state.detached, true);
    assert.equal(state.dirty, false);
    await access(fixture.checkoutPath);
  } finally {
    await fixture.cleanup();
  }
});

test("source reconciliation ignores inherited Git control variables", async () => {
  const fixture = await createFixture();
  const hostileGitDir = join(fixture.cacheRoot, "..", "hostile.git");
  const hostileWorkTree = join(fixture.cacheRoot, "..", "hostile-worktree");
  const hostileIndex = join(fixture.cacheRoot, "..", "hostile-index");
  const hostileEnvironment = {
    GIT_DIR: hostileGitDir,
    GIT_WORK_TREE: hostileWorkTree,
    GIT_INDEX_FILE: hostileIndex,
  };
  const previousEnvironment = Object.fromEntries(
    Object.keys(hostileEnvironment).map((name) => [name, process.env[name]]),
  );

  try {
    Object.assign(process.env, hostileEnvironment);
    const state = await reconcileSource(fixture.source, fixture.cacheRoot);
    assert.equal(state.actualCommit, fixture.firstCommit);
    assert.ok((await lstat(join(fixture.checkoutPath, ".git"))).isDirectory());
    for (const path of Object.values(hostileEnvironment)) {
      await assert.rejects(lstat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    }
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fixture.cleanup();
  }
});

test("source reconciliation ignores global Git hooks from HOME and XDG config", async () => {
  const fixture = await createFixture();
  const fixtureRoot = join(fixture.cacheRoot, "..");
  const hostileHome = join(fixtureRoot, "hostile-home");
  const hostileXdg = join(fixtureRoot, "hostile-xdg");
  const hooksDirectory = join(fixtureRoot, "hostile-hooks");
  const hookMarker = join(fixtureRoot, "external-hook-ran");
  const hookPath = join(hooksDirectory, "post-checkout");
  const previousEnvironment = {
    HOME: process.env.HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };

  try {
    await mkdir(join(hostileXdg, "git"), { recursive: true });
    await mkdir(hostileHome);
    await mkdir(hooksDirectory);
    const hostileConfig = `[core]\n\thooksPath = ${hooksDirectory}\n`;
    await writeFile(join(hostileHome, ".gitconfig"), hostileConfig);
    await writeFile(join(hostileXdg, "git", "config"), hostileConfig);
    await writeFile(hookPath, `#!/bin/sh\nprintf hooked > ${JSON.stringify(hookMarker)}\n`);
    await chmod(hookPath, 0o755);
    process.env.HOME = hostileHome;
    process.env.XDG_CONFIG_HOME = hostileXdg;

    const state = await reconcileSource(fixture.source, fixture.cacheRoot);

    assert.equal(state.actualCommit, fixture.firstCommit);
    assert.ok((await lstat(join(fixture.checkoutPath, ".git"))).isDirectory());
    await assert.rejects(access(hookMarker), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    if (previousEnvironment.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = previousEnvironment.HOME;
    if (previousEnvironment.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousEnvironment.XDG_CONFIG_HOME;
    await fixture.cleanup();
  }
});

test("source reconcile leaves a verified checkout unchanged", async () => {
  const fixture = await createFixture();
  try {
    await reconcileSource(fixture.source, fixture.cacheRoot);
    const before = await gitOutput(fixture.checkoutPath, "status", "--porcelain=v1", "--untracked-files=all");
    const state = await reconcileSource(fixture.source, fixture.cacheRoot);
    const after = await gitOutput(fixture.checkoutPath, "status", "--porcelain=v1", "--untracked-files=all");
    assert.equal(state.actualCommit, fixture.firstCommit);
    assert.equal(before, after);
  } finally {
    await fixture.cleanup();
  }
});

test("source verification does not refresh index metadata before rejecting an unsafe checkout", async () => {
  const fixture = await createFixture();
  try {
    await reconcileSource(fixture.source, fixture.cacheRoot);
    await writeFile(join(fixture.checkoutPath, "untracked.txt"), "untracked\n");
    const indexPath = join(fixture.checkoutPath, ".git", "index");
    const before = await stat(indexPath);
    await assert.rejects(verifySource(fixture.source, fixture.cacheRoot), /fixture.*dirty/i);
    const after = await stat(indexPath);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.size, before.size);
  } finally {
    await fixture.cleanup();
  }
});

test("source verification rejects local core.fsmonitor without executing it", async () => {
  const fixture = await createFixture();
  try {
    await reconcileSource(fixture.source, fixture.cacheRoot);
    const { hookPath, markerPath } = await createFsmonitorHook(fixture, "direct");
    await git(fixture.checkoutPath, "config", "core.fsmonitor", hookPath);
    let verificationError: unknown;

    try {
      await verifySource(fixture.source, fixture.cacheRoot);
    } catch (error) {
      verificationError = error;
    }

    await assert.rejects(access(markerPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assert.ok(verificationError instanceof Error);
    assert.match(verificationError.message, /fixture.*local Git config.*core\.fsmonitor/i);
  } finally {
    await fixture.cleanup();
  }
});

test("source verification rejects local include.path without following it", async () => {
  const fixture = await createFixture();
  try {
    await reconcileSource(fixture.source, fixture.cacheRoot);
    const { hookPath, markerPath } = await createFsmonitorHook(fixture, "included");
    const includedConfig = join(fixture.cacheRoot, "..", "included.gitconfig");
    await writeFile(includedConfig, `[core]\n\tfsmonitor = ${hookPath}\n`);
    await git(fixture.checkoutPath, "config", "--add", "include.path", includedConfig);
    let verificationError: unknown;

    try {
      await verifySource(fixture.source, fixture.cacheRoot);
    } catch (error) {
      verificationError = error;
    }

    await assert.rejects(access(markerPath), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assert.ok(verificationError instanceof Error);
    assert.match(verificationError.message, /fixture.*local Git config.*include\.path/i);
  } finally {
    await fixture.cleanup();
  }
});

test("source verification rejects a nested config redirected to a clean shadow worktree", async () => {
  const fixture = await createFixture({ submodule: true });
  try {
    await reconcileSource(fixture.source, fixture.cacheRoot, { allowFileTransport: true });
    const realChild = join(fixture.checkoutPath, "child");
    const shadowChild = join(fixture.checkoutPath, ".git", "shadow-child");
    const childConfig = join(fixture.checkoutPath, ".git", "modules", "child", "config");
    await writeFile(join(realChild, "untracked.txt"), "must be detected\n");
    await mkdir(shadowChild);
    await writeFile(join(shadowChild, "child.txt"), "child\n");
    await git(fixture.checkoutPath, "config", "--file", childConfig, "core.worktree", shadowChild);

    await assert.rejects(
      verifySource(fixture.source, fixture.cacheRoot),
      /fixture.*local Git config core\.worktree.*exact.*child/i,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("source verification rejects an unexpected HEAD", async () => {
  const fixture = await createFixture();
  try {
    await reconcileSource(fixture.source, fixture.cacheRoot);
    await git(fixture.checkoutPath, "fetch", "origin");
    await git(fixture.checkoutPath, "switch", "--detach", "FETCH_HEAD");
    await assert.rejects(verifySource(fixture.source, fixture.cacheRoot), /fixture.*unexpected commit.*sources fetch/i);
  } finally {
    await fixture.cleanup();
  }
});

test("source verification rejects an untracked file", async () => {
  const fixture = await createFixture();
  try {
    await reconcileSource(fixture.source, fixture.cacheRoot);
    await writeFile(join(fixture.checkoutPath, "untracked.txt"), "untracked\n");
    await assert.rejects(verifySource(fixture.source, fixture.cacheRoot), /fixture.*dirty/i);
  } finally {
    await fixture.cleanup();
  }
});

test("source verification rejects a modified tracked file", async () => {
  const fixture = await createFixture();
  try {
    await reconcileSource(fixture.source, fixture.cacheRoot);
    await writeFile(join(fixture.checkoutPath, "tracked.txt"), "modified\n");
    await assert.rejects(verifySource(fixture.source, fixture.cacheRoot), /fixture.*dirty/i);
  } finally {
    await fixture.cleanup();
  }
});

test("source reconciliation reports a missing expected commit", async () => {
  const fixture = await createFixture();
  try {
    const source = { ...fixture.source, commit: "f".repeat(40) };
    await assert.rejects(reconcileSource(source, fixture.cacheRoot), /fixture.*f{40}/i);
  } finally {
    await fixture.cleanup();
  }
});

test("source reconciliation rejects a source name that is not one safe path segment", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      reconcileSource({ ...fixture.source, name: "../outside" }, fixture.cacheRoot),
      /outside.*safe path segment/i,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("source reconciliation initializes a declared submodule at its recorded commit", async () => {
  const fixture = await createFixture({ submodule: true });
  try {
    const state = await reconcileSource(fixture.source, fixture.cacheRoot, { allowFileTransport: true });
    assert.equal(state.submodules.child, fixture.source.submodules.child);
    assert.equal(await gitOutput(join(fixture.checkoutPath, "child"), "rev-parse", "HEAD"), fixture.source.submodules.child);
  } finally {
    await fixture.cleanup();
  }
});

test("source reconciliation validates exact nested submodule config mappings", async () => {
  const fixture = await createFixture({ nestedSubmodule: true, submodule: true });
  try {
    const state = await reconcileSource(fixture.source, fixture.cacheRoot, { allowFileTransport: true });
    assert.equal(state.submodules.child, fixture.source.submodules.child);
    assert.equal(state.submodules["child/grandchild"], fixture.source.submodules["child/grandchild"]);
  } finally {
    await fixture.cleanup();
  }
});

test("source reconciliation rejects local submodule transport by default", async () => {
  const fixture = await createFixture({ submodule: true });
  try {
    await assert.rejects(reconcileSource(fixture.source, fixture.cacheRoot), /fixture.*could not create.*sources fetch/i);
  } finally {
    await fixture.cleanup();
  }
});

test("source verification accepts an equivalent normalized local origin", async () => {
  const fixture = await createFixture();
  try {
    await reconcileSource(fixture.source, fixture.cacheRoot);
    await git(fixture.checkoutPath, "remote", "set-url", "origin", `${fixture.source.repository}/`);
    const state = await verifySource(fixture.source, fixture.cacheRoot);
    assert.equal(state.actualCommit, fixture.source.commit);
  } finally {
    await fixture.cleanup();
  }
});

test("source verification rejects a symlinked cache root before touching its target", async () => {
  const fixture = await createFixture();
  const linkedCache = join(fixture.cacheRoot, "linked-cache");
  const outside = join(fixture.cacheRoot, "outside");
  try {
    await mkdir(fixture.cacheRoot);
    await git(fixture.cacheRoot, "init", outside);
    await symlink(outside, linkedCache);
    await assert.rejects(verifySource(fixture.source, linkedCache), /fixture.*symlink/i);
    assert.ok((await lstat(linkedCache)).isSymbolicLink());
    assert.ok((await lstat(join(outside, ".git"))).isDirectory());
  } finally {
    await fixture.cleanup();
  }
});

test("source reconciliation rejects a symlinked cache root before touching its target", async () => {
  const fixture = await createFixture();
  const linkedCache = join(fixture.cacheRoot, "linked-cache");
  const outside = join(fixture.cacheRoot, "outside");
  try {
    await mkdir(fixture.cacheRoot);
    await git(fixture.cacheRoot, "init", outside);
    await symlink(outside, linkedCache);
    await assert.rejects(reconcileSource(fixture.source, linkedCache), /fixture.*symlink/i);
    assert.ok((await lstat(linkedCache)).isSymbolicLink());
    assert.ok((await lstat(join(outside, ".git"))).isDirectory());
  } finally {
    await fixture.cleanup();
  }
});

test("source reconciliation rejects a symlinked cache parent before touching its target", async () => {
  const fixture = await createFixture();
  const outside = join(fixture.cacheRoot, "outside");
  const cacheParent = join(fixture.cacheRoot, ".cache");
  const nestedCache = join(cacheParent, "sources");
  try {
    await mkdir(join(outside, "sources"), { recursive: true });
    await symlink(outside, cacheParent);
    await assert.rejects(reconcileSource(fixture.source, nestedCache), /fixture.*cache parent.*symlink/i);
    assert.ok((await lstat(cacheParent)).isSymbolicLink());
    assert.ok((await lstat(join(outside, "sources"))).isDirectory());
  } finally {
    await fixture.cleanup();
  }
});

test("source reconciliation rejects a symlinked source-name directory before touching its target", async () => {
  const fixture = await createFixture();
  const outside = join(fixture.cacheRoot, "outside");
  try {
    await mkdir(fixture.cacheRoot);
    await git(fixture.cacheRoot, "init", outside);
    await symlink(outside, join(fixture.cacheRoot, fixture.source.name));
    await assert.rejects(reconcileSource(fixture.source, fixture.cacheRoot), /fixture.*symlink/i);
    assert.ok((await lstat(join(fixture.cacheRoot, fixture.source.name))).isSymbolicLink());
    assert.ok((await lstat(join(outside, ".git"))).isDirectory());
  } finally {
    await fixture.cleanup();
  }
});

test("source verification rejects a symlinked source-name directory before touching its target", async () => {
  const fixture = await createFixture();
  const outside = join(fixture.cacheRoot, "outside");
  try {
    await mkdir(fixture.cacheRoot);
    await git(fixture.cacheRoot, "init", outside);
    await symlink(outside, join(fixture.cacheRoot, fixture.source.name));
    await assert.rejects(verifySource(fixture.source, fixture.cacheRoot), /fixture.*symlink/i);
    assert.ok((await lstat(join(fixture.cacheRoot, fixture.source.name))).isSymbolicLink());
    assert.ok((await lstat(join(outside, ".git"))).isDirectory());
  } finally {
    await fixture.cleanup();
  }
});

test("source verification rejects a symlinked cache parent before touching its target", async () => {
  const fixture = await createFixture();
  const outside = join(fixture.cacheRoot, "outside");
  const cacheParent = join(fixture.cacheRoot, ".cache");
  const nestedCache = join(cacheParent, "sources");
  try {
    await mkdir(join(outside, "sources"), { recursive: true });
    await symlink(outside, cacheParent);
    await assert.rejects(verifySource(fixture.source, nestedCache), /fixture.*cache parent.*symlink/i);
    assert.ok((await lstat(cacheParent)).isSymbolicLink());
    assert.ok((await lstat(join(outside, "sources"))).isDirectory());
  } finally {
    await fixture.cleanup();
  }
});

test("source verification rejects a symlinked final destination before touching its target", async () => {
  const fixture = await createFixture();
  const outside = join(fixture.cacheRoot, "outside");
  try {
    await mkdir(join(fixture.cacheRoot, fixture.source.name), { recursive: true });
    await git(fixture.cacheRoot, "init", outside);
    await symlink(outside, fixture.checkoutPath);
    await assert.rejects(verifySource(fixture.source, fixture.cacheRoot), /fixture.*symlink/i);
    assert.ok((await lstat(fixture.checkoutPath)).isSymbolicLink());
    assert.ok((await lstat(join(outside, ".git"))).isDirectory());
  } finally {
    await fixture.cleanup();
  }
});

test("source reconciliation rejects a symlinked final destination before touching its target", async () => {
  const fixture = await createFixture();
  const outside = join(fixture.cacheRoot, "outside");
  try {
    await mkdir(join(fixture.cacheRoot, fixture.source.name), { recursive: true });
    await git(fixture.cacheRoot, "init", outside);
    await symlink(outside, fixture.checkoutPath);
    await assert.rejects(reconcileSource(fixture.source, fixture.cacheRoot), /fixture.*symlink/i);
    assert.ok((await lstat(fixture.checkoutPath)).isSymbolicLink());
    assert.ok((await lstat(join(outside, ".git"))).isDirectory());
  } finally {
    await fixture.cleanup();
  }
});
