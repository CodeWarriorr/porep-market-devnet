import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyPrune,
  assertPrunablePath,
  formatPrunePlan,
  parsePruneArguments,
  planPrune,
  type PrunePlan,
} from "../src/prune.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const oldest = "deployment-20261001T000000Z-aaaaaaaaaaaa";
const older = "deployment-20261002T000000Z-bbbbbbbbbbbb";
const middle = "deployment-20261003T000000Z-cccccccccccc";
const newer = "deployment-20261004T000000Z-dddddddddddd";
const newest = "deployment-20261005T000000Z-eeeeeeeeeeee";

type Fixture = {
  root: string;
  deployments: string;
  targets: string;
  cleanup(): Promise<void>;
};

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "runtime-prune-")));
  const deployments = join(root, ".runtime", "deployments");
  const targets = join(root, ".runtime", "contracts", "targets");
  await mkdir(deployments, { recursive: true });
  await mkdir(targets, { recursive: true });
  return { root, deployments, targets, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function snapshotPath(value: Fixture, seed: string): string {
  return join(value.targets, seed, "porep-market");
}

async function addTarget(value: Fixture, seed: string): Promise<void> {
  await mkdir(snapshotPath(value, seed), { recursive: true });
  await writeFile(join(snapshotPath(value, seed), "Market.sol"), "contract Market {}\n");
}

async function addDeployment(
  value: Fixture,
  id: string,
  upgradeSeeds: string[] = [],
): Promise<void> {
  const path = join(value.deployments, id);
  await mkdir(join(path, "revisions"), { recursive: true });
  await mkdir(join(path, "work"), { recursive: true });
  await writeFile(join(path, "work", "artifact.bin"), "x".repeat(8192));
  await writeFile(join(path, "target.json"), JSON.stringify({ snapshotPath: snapshotPath(value, id) }));
  await addTarget(value, id);
  for (const [index, seed] of [id, ...upgradeSeeds].entries()) {
    await writeFile(
      join(path, "revisions", `${String(index).padStart(3, "0")}.json`),
      JSON.stringify({ target: { snapshotPath: snapshotPath(value, seed) } }),
    );
    if (seed !== id) await addTarget(value, seed);
  }
}

async function activate(value: Fixture, id: string): Promise<void> {
  await writeFile(
    join(value.deployments, "active.json"),
    JSON.stringify({ schemaVersion: 1, deploymentId: id, revision: 0 }),
  );
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function removed(plan: PrunePlan): string[] {
  return plan.entries
    .filter((entry) => entry.action === "remove")
    .map((entry) => `${entry.kind}:${entry.name}`)
    .sort();
}

test("prune keeps the active deployment and its target even when it is the oldest", async () => {
  const value = await fixture();
  try {
    await addDeployment(value, oldest);
    await addDeployment(value, newest);
    await activate(value, oldest);

    const plan = await planPrune({ projectRoot: value.root, keep: 0 });
    await applyPrune(plan);

    assert.deepEqual(removed(plan), [`deployment:${newest}`, `target:${newest}`]);
    assert.equal(await present(join(value.deployments, oldest)), true);
    assert.equal(await present(snapshotPath(value, oldest)), true);
    assert.equal(await present(join(value.deployments, "active.json")), true);
    assert.equal(await present(join(value.deployments, newest)), false);
    assert.equal(await present(join(value.targets, newest)), false);
  } finally {
    await value.cleanup();
  }
});

test("prune keeps the N most recent other deployments and their upgrade targets", async () => {
  const value = await fixture();
  try {
    const upgradeSeed = `${newest}-upgrade-1-20261006T000000Z`;
    const removedUpgradeSeed = `${older}-upgrade-1-20261006T000000Z`;
    await addDeployment(value, oldest);
    await addDeployment(value, older, [removedUpgradeSeed]);
    await addDeployment(value, middle);
    await addDeployment(value, newer);
    await addDeployment(value, newest, [upgradeSeed]);
    await activate(value, oldest);

    const plan = await planPrune({ projectRoot: value.root, keep: 2 });
    await applyPrune(plan);

    assert.deepEqual(removed(plan), [
      `deployment:${older}`,
      `deployment:${middle}`,
      `target:${older}`,
      `target:${removedUpgradeSeed}`,
      `target:${middle}`,
    ].sort());
    for (const id of [oldest, newer, newest]) {
      assert.equal(await present(join(value.deployments, id)), true);
      assert.equal(await present(snapshotPath(value, id)), true);
    }
    assert.equal(await present(snapshotPath(value, upgradeSeed)), true);
    for (const id of [older, middle]) {
      assert.equal(await present(join(value.deployments, id)), false);
      assert.equal(await present(join(value.targets, id)), false);
    }
  } finally {
    await value.cleanup();
  }
});

test("prune keeps deployments that a journal or running upgrade still references", async () => {
  const value = await fixture();
  try {
    await addDeployment(value, oldest);
    await addDeployment(value, older);
    await addDeployment(value, newest);
    await activate(value, newest);
    await writeFile(
      join(value.root, ".runtime", "sector-evidence-adapter-switch.json"),
      JSON.stringify({ deploymentId: oldest, status: "switched" }),
    );
    await mkdir(join(value.deployments, older, ".upgrade.lock"));

    const plan = await planPrune({ projectRoot: value.root, keep: 0 });

    assert.deepEqual(removed(plan), []);
  } finally {
    await value.cleanup();
  }
});

test("prune removes orphaned deployment targets and leaves unrecognized directories", async () => {
  const value = await fixture();
  try {
    await addDeployment(value, newest);
    await activate(value, newest);
    await addTarget(value, oldest);
    await addTarget(value, `${older}-upgrade-1-20261006T000000Z`);
    await addTarget(value, "scratch");

    const plan = await planPrune({ projectRoot: value.root, keep: 2 });
    await applyPrune(plan);

    assert.deepEqual(removed(plan), [
      `target:${oldest}`,
      `target:${older}-upgrade-1-20261006T000000Z`,
    ].sort());
    assert.equal(await present(join(value.targets, "scratch")), true);
    assert.equal(await present(snapshotPath(value, newest)), true);
  } finally {
    await value.cleanup();
  }
});

test("prune removes contract test seeds older than the newest one", async () => {
  const value = await fixture();
  try {
    const seeds = [
      "contract-tests-20261001T000000Z-900",
      "contract-tests-20261002T000000Z-10",
      "contract-tests-20261002T000000Z-9",
    ];
    for (const seed of seeds) await addTarget(value, seed);

    const plan = await planPrune({ projectRoot: value.root, keep: 2 });
    await applyPrune(plan);

    assert.deepEqual(removed(plan), [
      "target:contract-tests-20261001T000000Z-900",
      "target:contract-tests-20261002T000000Z-9",
    ]);
    assert.equal(await present(join(value.targets, "contract-tests-20261002T000000Z-10")), true);
  } finally {
    await value.cleanup();
  }
});

test("prune refuses symbolic deployment entries and symbolic roots", async () => {
  const value = await fixture();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "runtime-prune-outside-")));
  try {
    await writeFile(join(outside, "keep.txt"), "outside\n");
    await addDeployment(value, newest);
    await activate(value, newest);
    await symlink(outside, join(value.deployments, oldest));

    await assert.rejects(planPrune({ projectRoot: value.root, keep: 0 }), /must not be symbolic/);
    await assert.rejects(
      assertPrunablePath(value.root, join(value.deployments, oldest)),
      /must not be symbolic/,
    );

    await rm(join(value.deployments, oldest));
    await rm(value.targets, { recursive: true });
    await symlink(outside, value.targets);
    await assert.rejects(planPrune({ projectRoot: value.root, keep: 0 }), /must not be symbolic/);

    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "outside\n");
    assert.equal(await present(join(value.deployments, newest)), true);
  } finally {
    await value.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("prune refuses paths outside the deployment and target roots", async () => {
  const value = await fixture();
  const outside = await realpath(await mkdtemp(join(tmpdir(), "runtime-prune-outside-")));
  try {
    await addDeployment(value, newest);
    await mkdir(join(value.root, ".runtime", "runs", "run-1"), { recursive: true });
    for (const path of [
      outside,
      join(value.root, ".runtime", "runs", "run-1"),
      join(value.root, ".runtime"),
      value.deployments,
      join(value.deployments, newest, "work"),
      `${value.deployments}/../runs/run-1`,
      join(value.deployments, "active.json"),
    ]) {
      await assert.rejects(assertPrunablePath(value.root, path), /refusing to prune/, path);
    }
    await assert.rejects(
      applyPrune({
        projectRoot: value.root,
        removeBytes: 0,
        entries: [{ kind: "deployment", name: "outside", path: outside, action: "remove", reason: "test", bytes: 0 }],
      }),
      /outside \.runtime\/deployments/,
    );
    assert.equal(await present(outside), true);
  } finally {
    await value.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test("prune dry run reports removals and sizes without deleting anything", async () => {
  const value = await fixture();
  try {
    await addDeployment(value, oldest);
    await addDeployment(value, middle);
    await addDeployment(value, newest);
    await activate(value, newest);
    await addTarget(value, "contract-tests-20261001T000000Z-1");
    await addTarget(value, "contract-tests-20261002T000000Z-1");

    const plan = await planPrune({ projectRoot: value.root, keep: 1 });
    const output = formatPrunePlan(plan, false);

    assert.equal(removed(plan).length, 3);
    assert.ok(plan.removeBytes > 8192);
    assert.match(output, new RegExp(`^remove\\tdeployment\\t${oldest}\\t[0-9.]+ KiB\\t`, "m"));
    assert.match(output, new RegExp(`^keep\\tdeployment\\t${newest}\\t-\\tactive$`, "m"));
    assert.match(output, /^dry run: would remove 3 entries, [0-9.]+ KiB; rerun with --apply to delete$/m);
    for (const id of [oldest, middle, newest]) {
      assert.equal(await present(join(value.deployments, id)), true);
      assert.equal(await present(snapshotPath(value, id)), true);
    }
    assert.equal(await present(join(value.targets, "contract-tests-20261001T000000Z-1")), true);
  } finally {
    await value.cleanup();
  }
});

test("prune arguments default to dry run and read the keep count from flag or env", () => {
  assert.deepEqual(parsePruneArguments(["deployment", "prune"], {}), { keep: 2, apply: false });
  assert.deepEqual(
    parsePruneArguments(["deployment", "prune"], { DEVNET_PRUNE_KEEP: "5" }),
    { keep: 5, apply: false },
  );
  assert.deepEqual(
    parsePruneArguments(["deployment", "prune", "--keep", "0", "--apply"], { DEVNET_PRUNE_KEEP: "5" }),
    { keep: 0, apply: true },
  );
  assert.throws(() => parsePruneArguments(["deployment", "prune", "--keep", "-1"], {}), /non-negative/);
  assert.throws(() => parsePruneArguments(["deployment", "prune", "--force"], {}), /usage/);
});

test("deploy prunes only after publishing active.json and contract tests clean their seed", async () => {
  const [justfile, deployScript, testScript] = await Promise.all([
    readFile(join(repositoryRoot, "justfile"), "utf8"),
    readFile(join(repositoryRoot, "scripts/devnet-deploy.sh"), "utf8"),
    readFile(join(repositoryRoot, "scripts/contracts-test-target.sh"), "utf8"),
  ]);
  const publish = deployScript.indexOf('mv -- "${active_temporary}" "${active}"');
  const prune = deployScript.indexOf("deployment prune --apply");
  assert.ok(publish > 0 && prune > publish);
  assert.match(deployScript, /^set -euo pipefail$/m);
  assert.match(justfile, /^prune keep=.*:\n\s+@npm .* deployment prune --keep '\{\{keep\}\}'\n/m);
  assert.match(justfile, /^prune-apply keep=.*:\n\s+@npm .* deployment prune --keep '\{\{keep\}\}' --apply\n/m);
  assert.match(testScript, /trap remove_test_target EXIT/);
  assert.match(testScript, /DEVNET_KEEP_CONTRACT_TEST_TARGET/);
  assert.match(testScript, /devnet_require_safe_write_path "\$\{seed_root\}" directory/);
});
