import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Evm } from "../contracts/evm.js";
import { ContractRevertError } from "../contracts/reverts.js";
import { contracts } from "../contracts/views.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
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
  const beforeRail = await view.rail(railId);
  const beforePayeeFunds = await view.accountFunds(beforeRail.to);

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

  const targetEpoch = beforeRail.settledUpTo + 1n;
  await runStep(context, "reject zero-paid settlement without cursor loss", async () => {
    try {
      await evm.simulate(
        context.config.addresses.filecoinPay,
        "settleRail(uint256,uint256)",
        [railId, targetEpoch],
      );
    } catch (error) {
      if (!(error instanceof ContractRevertError)) throw error;
      await assertCurrentSettlementState(view, railId, beforeRail.settledUpTo, beforePayeeFunds);
      context.state.set("TERMINATION_SETTLEMENT_RESULT", "reverted");
      return;
    }
    await evm.send(
      context.config.addresses.filecoinPay,
      "settleRail(uint256,uint256)",
      [railId, targetEpoch],
    );
    const afterRail = await view.rail(railId);
    const afterPayeeFunds = await view.accountFunds(afterRail.to);
    assertZeroPaymentDidNotAdvance({
      beforeCursor: beforeRail.settledUpTo,
      afterCursor: afterRail.settledUpTo,
      beforePayeeFunds,
      afterPayeeFunds,
    });
    context.state.set("TERMINATION_SETTLEMENT_RESULT", "unchanged");
  });

  context.state.set("TERMINATED_CLAIM_IDS_CSV", claimIds.join(","));
  context.state.set("TERMINATION_SETTLEMENT_TARGET", targetEpoch);
  context.state.set("TERMINATION_DEAL_ID", dealId);
}

async function assertCurrentSettlementState(
  view: ReturnType<typeof contracts>,
  railId: bigint,
  beforeCursor: bigint,
  beforePayeeFunds: bigint,
): Promise<void> {
  const afterRail = await view.rail(railId);
  assertZeroPaymentDidNotAdvance({
    beforeCursor,
    afterCursor: afterRail.settledUpTo,
    beforePayeeFunds,
    afterPayeeFunds: await view.accountFunds(afterRail.to),
  });
}

export function assertZeroPaymentDidNotAdvance(input: {
  beforeCursor: bigint;
  afterCursor: bigint;
  beforePayeeFunds: bigint;
  afterPayeeFunds: bigint;
}): void {
  assert.equal(
    input.afterPayeeFunds,
    input.beforePayeeFunds,
    "termination settlement unexpectedly paid the provider",
  );
  assert.equal(
    input.afterCursor,
    input.beforeCursor,
    "zero-paid settlement consumed the rail cursor",
  );
}
