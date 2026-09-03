import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { E2EConfig } from "../src/config.js";
import {
  createScenarioContext,
  runStep,
  writeRunSummary,
} from "../src/runtime.js";

test("failed scenario summary binds the run to one deployment revision", async () => {
  const runDir = mkdtempSync(join(tmpdir(), "scenario-runtime-"));
  const context = createScenarioContext(config(runDir), runDir, "run-test");
  await assert.rejects(
    runStep(context, "failing action", () => {
      throw new Error("expected failure");
    }),
    /expected failure/,
  );
  const summaryPath = writeRunSummary(context, "failed", new Error("expected failure"));
  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
  assert.equal(summary.result, "failed");
  assert.equal(summary.runId, "run-test");
  assert.equal(summary.deploymentId, "deployment-test");
  assert.equal(summary.deploymentRevision, 2);
  assert.equal(summary.error, "expected failure");
});

function config(projectRoot: string): E2EConfig {
  const address = "0x1111111111111111111111111111111111111111";
  const key = `0x${"1".repeat(64)}`;
  return {
    cwd: projectRoot,
    projectRoot,
    envFile: "",
    rpcUrl: "http://127.0.0.1:2234/rpc/v1",
    expectedChainId: 31415926,
    expectedPorepCommit: "a".repeat(40),
    deploymentPorepCommit: "a".repeat(40),
    deploymentTargetMode: "locked",
    deploymentTargetDirty: false,
    deploymentId: "deployment-test",
    deploymentRevision: 2,
    deploymentRecordPath: join(projectRoot, "002.json"),
    privateKeyTest: key,
    privateKeySp: key,
    identityKeys: {
      deployer: key, client: key, providerPayee: key, porepService: key,
      operator: key, allocator: key, oracle: key, unauthorized: key,
    },
    identityAddresses: {
      deployer: address, client: address, providerPayee: address, porepService: address,
      operator: address, allocator: address, oracle: address, unauthorized: address,
    },
    generation: "generation-test",
    provider: "t01004",
    porepSourceDir: projectRoot,
    runRoot: projectRoot,
    addresses: {
      poRepMarket: address, spRegistry: address, validatorFactory: address,
      dataCapEvidenceAdapter: address, filecoinPay: address, sliOracle: address,
      sectorEvidenceAdapter: address,
      metaAllocator: address, usdcToken: address, notificationReceiver: address,
      failingNotificationReceiver: address, sectorStatusInspector: address,
    },
    requiredEnv: {},
    env: {},
  };
}
