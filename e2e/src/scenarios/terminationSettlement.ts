import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Evm } from "../contracts/evm.js";
import { contracts } from "../contracts/views.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import { configureSettlementCadenceForDevnet, setSliAttestationForDeal, settleRailAtEpochAndAssertOutcome } from "../flows/settlement.js";
import { runBasicActivationFlow } from "./basicActivationFlow.js";

export async function runTerminationSettlement(
  context: ScenarioContext,
): Promise<void> {
  await runStep(context, "populate active evidence-backed deal", () =>
    runBasicActivationFlow(context));
  const dealId = BigInt(context.state.require("DEAL_ID"));
  const railId = BigInt(context.state.require("RAIL_ID"));
  const claimIds = context.state.require("CLAIM_IDS_CSV")
    .split(",")
    .filter(Boolean)
    .map(BigInt);
  assert.ok(claimIds.length > 0, "termination scenario needs provider claims");

  const revision = JSON.parse(
    readFileSync(context.config.deploymentRecordPath, "utf8"),
  ) as { contracts: Record<string, { address: string }> };
  const terminationOracle = revision.contracts.TerminationOracle?.address;
  assert.ok(terminationOracle, "TerminationOracle is missing");
  const evm = new Evm(context);
  const view = contracts(context);
  await runStep(context, "set SLI attestation before terminated-evidence settlement", () =>
    setSliAttestationForDeal(context, { dealId }));
  await runStep(context, "configure one-epoch settlement cadence", async () => {
    context.config.env.V2_MIN_SETTLEMENT_EPOCHS = "1";
    await configureSettlementCadenceForDevnet(context, { dealId });
  });
  const beforeRail = await view.rail(railId);
  const beforeService = await view.dealService(dealId);

  await runStep(context, "mark every deal claim terminated", async () => {
    await evm.send(
      terminationOracle,
      "report(address,uint64[])",
      [context.config.addresses.dataCapEvidenceAdapter, `[${claimIds.join(",")}]`],
    );
    const adapter = evm.contract(
      context.config.addresses.dataCapEvidenceAdapter,
      ["function isClaimTerminated(uint64) view returns (bool)"],
    );
    for (const claim of claimIds) {
      assert.equal(await adapter.isClaimTerminated(claim), true);
    }
  });

  await runStep(context, "refresh terminated claim evidence to data-size mismatch", async () => {
    const evidenceData = evm.abiEncode("f(uint256)", BigInt(claimIds.length));
    await evm.sendWithPrivateKey(
      context.config.identityKeys.porepService,
      context.config.addresses.poRepMarket,
      "refreshEvidenceStatus(uint256,bytes)",
      [dealId, evidenceData],
    );
    const status = await view.evidenceStatus(dealId);
    assert.equal(status.activeCoveredBytes, 0n, "terminated evidence active covered bytes");
    assert.equal(status.result, 60n, "terminated evidence result COVERED_BYTES_MISMATCH");
    assert.equal(status.checkedClaims, status.totalClaims, "terminated evidence checked all claims");
  });

  const targetEpoch = beforeRail.settledUpTo + 1n;
  await runStep(context, "advance zero-paid settlement across terminated evidence mismatch", async () => {
    await settleRailAtEpochAndAssertOutcome(context, { dealId }, { railId }, targetEpoch, {
      settlementAmount: 0n,
      settleUpto: targetEpoch,
      note: "data size does not match the deal",
    }, beforeService.lastSettledEpoch);
    const afterRail = await view.rail(railId);
    assert.equal(afterRail.settledUpTo, targetEpoch, "termination settlement rail cursor");
    context.state.set("TERMINATION_SETTLEMENT_RESULT", "zero-paid-data-size-mismatch");
  });

  context.state.set("TERMINATED_CLAIM_IDS_CSV", claimIds.join(","));
  context.state.set("TERMINATION_SETTLEMENT_TARGET", targetEpoch);
  context.state.set("TERMINATION_DEAL_ID", dealId);
}
