import assert from "node:assert/strict";
import { Evm } from "../contracts/evm.js";
import { ensureActiveSectorFixture } from "../fixtures/activeSector.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";

export async function runSectorStatusActive(context: ScenarioContext): Promise<void> {
  const fixture = await runStep(context, "reuse or create active sector fixture", () =>
    ensureActiveSectorFixture(context));
  const deal = await runStep(context, "propose provider lookup deal", () =>
    proposeDealAndAssertAccepted(deployedOfferContext(context)));
  const result = await runStep(context, "validate active sector", () =>
    validateSectorStatus(
      context,
      deal.dealId,
      fixture.sector,
      1,
      fixture.deadline,
      fixture.partition,
    ));

  assert.equal(result, true);
  context.state.set("SECTOR_NUMBER", fixture.sector);
  context.state.set("SECTOR_DEADLINE", fixture.deadline);
  context.state.set("SECTOR_PARTITION", fixture.partition);
  context.state.set("SECTOR_STATUS_ACTIVE", String(result));
  context.state.set(
    "SECTOR_STATUS_FAULTY_FIXTURE",
    "skipped: no deterministic bounded fault injection in this DevNet",
  );
  context.state.set(
    "SECTOR_STATUS_TERMINATED_FIXTURE",
    "skipped: no deterministic bounded termination fixture in this DevNet",
  );
}

export async function runSectorStatusNegative(context: ScenarioContext): Promise<void> {
  const unknownSector = Number.MAX_SAFE_INTEGER;
  const deal = await runStep(context, "propose provider lookup deal", () =>
    proposeDealAndAssertAccepted(deployedOfferContext(context)));
  const result = await runStep(context, "reject unknown sector as active", () =>
    validateSectorStatus(context, deal.dealId, unknownSector, 1, -1, -1));

  assert.equal(result, false);
  context.state.set("UNKNOWN_SECTOR_NUMBER", unknownSector);
  context.state.set("UNKNOWN_SECTOR_ACTIVE", String(result));
}

function deployedOfferContext(context: ScenarioContext): ScenarioContext {
  return {
    ...context,
    config: {
      ...context.config,
      env: {
        ...context.config.env,
        V2_PRICE_PER_32GIB_MONTH: "1000000",
        V2_RETRIEVABILITY_BPS: "9000",
        V2_BANDWIDTH_BYTES_PER_SECOND: "1048576",
        V2_LATENCY_MS: "1000",
        V2_INDEXING_PCT: "100",
      },
    },
  };
}

async function validateSectorStatus(
  context: ScenarioContext,
  dealId: bigint,
  sector: number,
  status: number,
  deadline: number,
  partition: number,
): Promise<boolean> {
  const output = await new Evm(context).simulate(
    context.config.addresses.sectorStatusInspector,
    "validateSectorStatus(uint256,uint64,uint8,int64,int64)(bool)",
    [dealId, sector, status, deadline, partition],
  );
  if (output === "true") return true;
  if (output === "false") return false;
  throw new Error(`unexpected sector-status result: ${output}`);
}
