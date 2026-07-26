import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createUpgradePlan,
  validateUpgradePreflight,
} from "../src/upgrade.js";
import type { DeploymentRevision } from "../src/deployment.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("upgrade plan accepts UUPS and Validator beacon steps", () => {
  const plan = createUpgradePlan({
    revision: deployment(),
    targetSnapshotPath: "/tmp/target",
    contracts: ["PoRepMarket", "ValidatorBeacon"],
  });
  assert.deepEqual(plan.steps, [
    { contract: "PoRepMarket", kind: "uups", calldata: "0x" },
    { contract: "ValidatorBeacon", kind: "validator-beacon", calldata: "0x" },
  ]);
});

test("upgrade plan rejects unknown, duplicate, and direct contracts", () => {
  assert.throws(() => createUpgradePlan({
    revision: deployment(), targetSnapshotPath: "/tmp/target", contracts: ["Missing"],
  }), /unknown contract/);
  assert.throws(() => createUpgradePlan({
    revision: deployment(), targetSnapshotPath: "/tmp/target",
    contracts: ["PoRepMarket", "PoRepMarket"],
  }), /duplicate upgrade contract/);
  assert.throws(() => createUpgradePlan({
    revision: deployment(), targetSnapshotPath: "/tmp/target", contracts: ["FilecoinPay"],
  }), /direct contract/);
});

test("upgrade preflight rejects stale implementations, missing authority, and malformed calldata", () => {
  const revision = deployment();
  const plan = createUpgradePlan({
    revision, targetSnapshotPath: "/tmp/target", contracts: ["PoRepMarket"],
  });
  assert.throws(() => validateUpgradePreflight({
    plan: { ...plan, fromRevision: 2 },
    revision,
    liveImplementations: { PoRepMarket: address("9") },
    authorizedContracts: new Set(["PoRepMarket"]),
  }), /stale fromRevision/);
  assert.throws(() => validateUpgradePreflight({
    plan,
    revision,
    liveImplementations: { PoRepMarket: address("9") },
    authorizedContracts: new Set(["PoRepMarket"]),
  }), /implementation mismatch/);
  assert.throws(() => validateUpgradePreflight({
    plan,
    revision,
    liveImplementations: { PoRepMarket: address("2") },
    authorizedContracts: new Set(),
  }), /missing upgrade authority/);
  assert.throws(() => validateUpgradePreflight({
    plan: { ...plan, steps: [{ ...plan.steps[0]!, calldata: "initialize()" }] },
    revision,
    liveImplementations: { PoRepMarket: address("2") },
    authorizedContracts: new Set(["PoRepMarket"]),
  }), /calldata must be explicit hex/);
});

test("upgrade execution is locked, resumable, and verifies the requested transaction and code", async () => {
  const script = await readFile(
    resolve(repositoryRoot, "scripts", "devnet-upgrade.sh"),
    "utf8",
  );
  assert.match(script, /mkdir "\$\{upgrade_lock\}"/);
  assert.match(script, /upgrade finalized after interrupted publication/);
  assert.match(script, /live implementation does not match the requested target/);
  assert.match(script, /live implementation code does not match the compiled target/);
  assert.match(script, /requested target has unchanged implementation code/);
  assert.equal(script.match(/read -r contract_name kind calldata <&3/g)?.length, 2);
  assert.equal(script.match(/done 3< <\(jq -r/g)?.length, 2);
  assert.match(script, /\.transactionType == "CALL"/);
  assert.match(script, /\.transaction\.to/);
  assert.match(script, /\.status.*0x1/);
  assert.doesNotMatch(script, /broadcast\/\$\{broadcast_script\}\/31415926/);
  assert.doesNotMatch(script, /printf -v timestamp '%\(/);
});

function deployment(): DeploymentRevision {
  return {
    schemaVersion: 2,
    deploymentId: "deployment-test",
    revision: 1,
    parentRevision: 0,
    generatedAt: "2026-07-26T00:00:00Z",
    chain: {
      generation: "generation-test",
      genesisCid: `baf${"a".repeat(30)}`,
      chainId: 31415926,
      epoch: 10,
      provider: "t01004",
    },
    target: {
      mode: "locked", sourcePath: "/tmp/source", snapshotPath: "/tmp/old",
      commit: "a".repeat(40), dirty: false, submodules: {},
    },
    identities: { deployer: address("1") },
    contracts: {
      PoRepMarket: {
        address: address("1"), runtimeCodeHash: hash("1"), kind: "uups",
        implementation: address("2"), implementationCodeHash: hash("2"),
      },
      ValidatorBeacon: {
        address: address("3"), runtimeCodeHash: hash("3"), kind: "beacon",
        implementation: address("4"), implementationCodeHash: hash("4"),
      },
      FilecoinPay: {
        address: address("5"), runtimeCodeHash: hash("5"), kind: "direct",
      },
    },
    transactions: [],
  };
}

function address(value: string): string {
  return `0x${value.repeat(40)}`;
}

function hash(value: string): string {
  return `0x${value.repeat(64)}`;
}
