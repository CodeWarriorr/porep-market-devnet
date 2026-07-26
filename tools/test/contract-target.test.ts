import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareContractTarget } from "../src/contract-target.js";
import { parseContractTargetArguments } from "../src/cli.js";
import { run } from "../src/process.js";

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run("git", args, { cwd, timeoutMs: 10_000 })).stdout.trim();
}

async function fixture(): Promise<{
  projectRoot: string;
  checkout: string;
  commit: string;
  cleanup(): Promise<void>;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "contract-target-"));
  const checkout = join(projectRoot, "checkout");
  await git(projectRoot, "init", checkout);
  await git(checkout, "config", "user.name", "Contract target fixture");
  await git(checkout, "config", "user.email", "contract-target@example.test");
  await writeFile(join(checkout, "Market.sol"), "contract Market {}\n");
  await git(checkout, "add", "Market.sol");
  await git(checkout, "commit", "-m", "fixture");
  const commit = await git(checkout, "rev-parse", "HEAD");
  await writeFile(
    join(projectRoot, "versions.lock.yaml"),
    `schema_version: 1\nsources:\n  porep_market:\n    repository: https://example.test/porep.git\n    commit: ${commit}\n    submodules: {}\n`,
  );
  const locked = join(projectRoot, ".cache", "sources", "porep_market", commit);
  await run("cp", ["-R", checkout, locked], { cwd: projectRoot, timeoutMs: 10_000 })
    .catch(async () => {
      const { mkdir, cp } = await import("node:fs/promises");
      await mkdir(join(projectRoot, ".cache", "sources", "porep_market"), { recursive: true });
      await cp(checkout, locked, { recursive: true });
    });
  return {
    projectRoot,
    checkout,
    commit,
    cleanup: () => rm(projectRoot, { recursive: true, force: true }),
  };
}

test("contract target prepares the locked source by default", async () => {
  const value = await fixture();
  try {
    const target = await prepareContractTarget({
      projectRoot: value.projectRoot,
      deploymentSeed: "deployment-locked",
    });
    assert.equal(target.mode, "locked");
    assert.equal(target.commit, value.commit);
    assert.equal(target.dirty, false);
    assert.equal(await readFile(join(target.snapshotPath, "Market.sol"), "utf8"), "contract Market {}\n");
  } finally {
    await value.cleanup();
  }
});

test("contract target accepts an explicit dirty absolute checkout", async () => {
  const value = await fixture();
  try {
    await writeFile(join(value.checkout, "Market.sol"), "contract Market { function changed() external {} }\n");
    const target = await prepareContractTarget({
      projectRoot: value.projectRoot,
      sourcePath: value.checkout,
      deploymentSeed: "deployment-local",
    });
    assert.equal(target.mode, "local");
    assert.equal(target.commit, value.commit);
    assert.equal(target.dirty, true);
    assert.match(await readFile(join(target.snapshotPath, "Market.sol"), "utf8"), /changed/);
  } finally {
    await value.cleanup();
  }
});

test("contract target rejects relative sources and existing snapshot destinations", async () => {
  const value = await fixture();
  try {
    await assert.rejects(
      prepareContractTarget({
        projectRoot: value.projectRoot,
        sourcePath: "checkout",
        deploymentSeed: "deployment-relative",
      }),
      /absolute path/,
    );
    await prepareContractTarget({
      projectRoot: value.projectRoot,
      sourcePath: value.checkout,
      deploymentSeed: "deployment-existing",
    });
    await assert.rejects(
      prepareContractTarget({
        projectRoot: value.projectRoot,
        sourcePath: value.checkout,
        deploymentSeed: "deployment-existing",
      }),
      /already exists/,
    );
  } finally {
    await value.cleanup();
  }
});

test("contract target CLI accepts only seed plus an optional source", () => {
  assert.deepEqual(
    parseContractTargetArguments(["contract-target", "prepare", "deployment-a"]),
    { deploymentSeed: "deployment-a" },
  );
  assert.deepEqual(
    parseContractTargetArguments([
      "contract-target",
      "prepare",
      "deployment-b",
      "--source",
      "/tmp/porep",
    ]),
    { deploymentSeed: "deployment-b", sourcePath: "/tmp/porep" },
  );
  assert.throws(
    () => parseContractTargetArguments(["contract-target", "prepare", "deployment-c", "--dirty"]),
    /usage/,
  );
});
