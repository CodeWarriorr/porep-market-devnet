import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import { contracts } from "../contracts/views.js";
import { runBasicActivationFlow } from "./basicActivationFlow.js";
import { runProposalSmoke } from "./smokeFlows.js";
import { refreshEvidenceStatusAndAssertActive } from "../flows/settlement.js";

type ContractIdentity = {
  address: string;
  implementation?: string;
  kind: string;
};

type ContinuityRecord = {
  deploymentId: string;
  deploymentRevision: number;
  contracts: Record<string, ContractIdentity>;
  deal: unknown;
  dealData: unknown;
  dealTerms: unknown;
  dealCapacity: unknown;
  dealPayment: unknown;
  dealService: unknown;
  evidenceStatus: unknown;
  rail: unknown;
};

export async function runUpgradeContinuity(
  context: ScenarioContext,
): Promise<void> {
  const phase = process.env.UPGRADE_PHASE;
  const beforePath = join(context.runDir, "upgrade-before.json");
  if (phase === "before") {
    await runStep(context, "populate pre-upgrade market state", () =>
      runBasicActivationFlow(context));
    const before = await runStep(context, "capture pre-upgrade state", () =>
      captureContinuity(context));
    writeFileSync(beforePath, `${JSON.stringify(before, stringifyBigInt, 2)}\n`);
    return;
  }
  if (phase !== "after") {
    throw new Error("UPGRADE_PHASE must be before or after");
  }

  const before = JSON.parse(readFileSync(beforePath, "utf8")) as ContinuityRecord;
  const after = normalizeRecord(
    await runStep(context, "capture post-upgrade state", () =>
      captureContinuity(context)),
  );
  await runStep(context, "assert populated state survived upgrade", () =>
    assertUpgradeContinuity(
      before,
      after,
      (process.env.UPGRADE_CONTRACTS ?? "").split(",").filter(Boolean),
    ));
  await runStep(context, "continue pre-upgrade evidence", () =>
    refreshEvidenceStatusAndAssertActive(context, {
      dealId: BigInt(context.state.require("DEAL_ID")),
      committedBytes: BigInt(context.state.require("COMMITTED_BYTES")),
      paymentRate: BigInt(context.state.require("PAYMENT_RATE")),
    }));
  const preUpgradeDealId = context.state.require("DEAL_ID");
  await runStep(context, "create a post-upgrade deal", () =>
    runProposalSmoke(context));
  writeFileSync(
    join(context.runDir, "upgrade-after.json"),
    `${JSON.stringify({
      verifiedRevision: after.deploymentRevision,
      preUpgradeDealId,
      postUpgradeDealId: context.state.get("DEAL_ID"),
    }, null, 2)}\n`,
  );
}

export function assertUpgradeContinuity(
  before: ContinuityRecord,
  after: ContinuityRecord,
  upgradedContracts: string[],
): void {
  assert.equal(after.deploymentId, before.deploymentId);
  assert.equal(after.deploymentRevision, before.deploymentRevision + 1);
  const replacedImplementationEntries = new Set(
    upgradedContracts.map((name) =>
      name === "ValidatorBeacon" ? "ValidatorImplementation" : `${name}Implementation`
    ),
  );
  for (const [name, previous] of Object.entries(before.contracts)) {
    const current = after.contracts[name];
    assert.ok(current, `missing contract after upgrade: ${name}`);
    if (!replacedImplementationEntries.has(name)) {
      assert.equal(current.address.toLowerCase(), previous.address.toLowerCase());
    }
    if (upgradedContracts.includes(name)) {
      assert.notEqual(
        current.implementation?.toLowerCase(),
        previous.implementation?.toLowerCase(),
        `${name} implementation did not change`,
      );
    }
  }
  assert.deepEqual(after.deal, before.deal);
  assert.deepEqual(after.dealData, before.dealData);
  assert.deepEqual(after.dealTerms, before.dealTerms);
  assert.deepEqual(after.dealCapacity, before.dealCapacity);
  assert.deepEqual(after.dealPayment, before.dealPayment);
  assert.deepEqual(after.dealService, before.dealService);
  assert.deepEqual(after.evidenceStatus, before.evidenceStatus);
  assert.deepEqual(after.rail, before.rail);
}

async function captureContinuity(
  context: ScenarioContext,
): Promise<ContinuityRecord> {
  const revision = JSON.parse(
    readFileSync(context.config.deploymentRecordPath, "utf8"),
  ) as { contracts: Record<string, ContractIdentity> };
  const dealId = BigInt(context.state.require("DEAL_ID"));
  const railId = BigInt(context.state.require("RAIL_ID"));
  const view = contracts(context);
  return {
    deploymentId: context.config.deploymentId,
    deploymentRevision: context.config.deploymentRevision,
    contracts: revision.contracts,
    deal: await view.deal(dealId),
    dealData: await view.dealData(dealId),
    dealTerms: await view.dealTerms(dealId),
    dealCapacity: await view.dealCapacity(dealId),
    dealPayment: await view.dealPayment(dealId),
    dealService: await view.dealService(dealId),
    evidenceStatus: await view.evidenceStatus(dealId),
    rail: await view.rail(railId),
  };
}

function stringifyBigInt(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function normalizeRecord(record: ContinuityRecord): ContinuityRecord {
  return JSON.parse(JSON.stringify(record, stringifyBigInt)) as ContinuityRecord;
}
