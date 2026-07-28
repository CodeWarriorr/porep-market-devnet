import type { ScenarioContext } from "../runtime.js";
import { assertEqual } from "../assertions.js";
import { runStep } from "../runtime.js";
import { Evm } from "../contracts/evm.js";
import { contracts } from "../contracts/views.js";
import { settlementAmount, billed32GiBUnits } from "../expected.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import {
  createPreparedRailAndAssertRate,
  createValidatorForDeal,
  depositAndApproveValidatorOperator
} from "../flows/validatorRail.js";
import {
  finishDataCapPostingAndAssertAllocated,
  generatePiece,
  importPieceAndWaitForProviderClaim,
  submitDataCapAllocation
} from "../flows/datacap.js";
import {
  activateEvidenceAndAssertDealActive,
  submitEvidenceBatchAndAssertClaimCoverage
} from "../flows/evidence.js";
import {
  configureSettlementCadenceForDevnet,
  expectSettlementBlockedWithoutPayout,
  refreshEvidenceStatusAndAssertActive,
  setSliAttestationForDeal,
  settleRailAtEpochAndAssertOutcome,
  settleRailAgainAtSameTargetAndAssertNoPayout,
  settleRailAndAssertProviderPayout,
  waitForSettlementWindow
} from "../flows/settlement.js";

export async function runSettlementGuards(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer", () => registerDevnetProviderAndOffer(context));
  const deal = await runStep(context, "propose accepted deal", () => proposeDealAndAssertAccepted(context, offer));
  const validator = await runStep(context, "deploy validator", () => createValidatorForDeal(context, deal));
  await runStep(context, "deposit and approve validator operator", () => depositAndApproveValidatorOperator(context, deal, validator));
  const rail = await runStep(context, "create prepared rail", () => createPreparedRailAndAssertRate(context, deal, validator));
  const piece = await runStep(context, "generate piece", () => generatePiece(context));
  const allocation = await runStep(context, "submit DataCap allocation", () => submitDataCapAllocation(context, deal, piece));
  await runStep(context, "import piece and wait for provider claim", () => importPieceAndWaitForProviderClaim(context, allocation));
  await runStep(context, "finish DataCap posting", () => finishDataCapPostingAndAssertAllocated(context, deal));
  await runStep(context, "submit evidence batch", () => submitEvidenceBatchAndAssertClaimCoverage(context, deal));
  const active = await runStep(context, "activate evidence", () => activateEvidenceAndAssertDealActive(context, deal, rail));
  await runStep(context, "configure one-epoch settlement cadence", () => configureSettlementCadenceForDevnet(context, deal));
  await runStep(context, "wait for settlement window before no-SLI check", () => waitForSettlementWindow(context, deal, rail));
  await runStep(context, "refresh evidence before no-SLI check", () => refreshEvidenceStatusAndAssertActive(context, active));
  await runStep(context, "prove settlement without SLI is blocked", () =>
    expectSettlementBlockedWithoutPayout(context, deal.dealId, rail, new Evm(context).blockNumber(), "NoAttestation")
  );
  await runStep(context, "set SLI attestation", () => setSliAttestationForDeal(context, deal));
  await runStep(context, "configure long settlement cadence", () => {
    context.config.env.V2_MIN_SETTLEMENT_EPOCHS = "1000";
    return configureSettlementCadenceForDevnet(context, deal);
  });
  await runStep(context, "prove settlement too early is blocked", () =>
    expectSettlementBlockedWithoutPayout(context, deal.dealId, rail, new Evm(context).blockNumber(), "NoProgressInSettlement")
  );
  await runStep(context, "restore one-epoch settlement cadence", () => {
    context.config.env.V2_MIN_SETTLEMENT_EPOCHS = "1";
    return configureSettlementCadenceForDevnet(context, deal);
  });
  await runStep(context, "wait for failing-SLI settlement window", () => waitForSettlementWindow(context, deal, rail));
  await runStep(context, "refresh evidence before failing-SLI settlement", () => refreshEvidenceStatusAndAssertActive(context, active));
  const forfeited = await runStep(context, "forfeit the failing-SLI settlement window", async () => {
    const view = contracts(context);
    const evm = new Evm(context);
    const requiredSlis = await view.dealSlis(deal.dealId);
    if (requiredSlis.latencyMs === 0n || requiredSlis.latencyMs === 65_535n) {
      throw new Error(`cannot construct a failing latency attestation from required latency ${requiredSlis.latencyMs}`);
    }
    const previousLatencyMs = context.config.env.V2_SLI_LATENCY_MS;
    context.config.env.V2_SLI_LATENCY_MS = (requiredSlis.latencyMs + 1n).toString();
    await setSliAttestationForDeal(context, deal);
    const beforeRail = await view.rail(rail.railId);
    const targetEpoch = evm.blockNumber();
    if (targetEpoch <= beforeRail.settledUpTo) {
      throw new Error(`failing-SLI target ${targetEpoch} must be after rail cursor ${beforeRail.settledUpTo}`);
    }
    const service = await view.dealService(deal.dealId);
    const payment = await view.dealPayment(deal.dealId);
    const forfeitedGross = settlementAmount(
      payment.pricePer32GiBPerMonth,
      billed32GiBUnits(active.committedBytes),
      service.startEpoch,
      beforeRail.settledUpTo,
      targetEpoch,
    );
    if (forfeitedGross <= 0n) {
      throw new Error(`failing-SLI forfeited window expected positive gross payment, got ${forfeitedGross}`);
    }
    const serviceBefore = await view.dealService(deal.dealId);
    await settleRailAtEpochAndAssertOutcome(context, deal, rail, targetEpoch, {
      settlementAmount: 0n,
      settleUpto: targetEpoch,
      note: "score below required threshold",
    }, serviceBefore.lastSettledEpoch);
    const afterRail = await view.rail(rail.railId);
    assertEqual(afterRail.settledUpTo, targetEpoch, "failing SLI rail cursor");
    return { targetEpoch, previousLatencyMs, gross: forfeitedGross };
  });
  await runStep(context, "restore passing SLI attestation", async () => {
    if (forfeited.previousLatencyMs === undefined) {
      delete context.config.env.V2_SLI_LATENCY_MS;
    } else {
      context.config.env.V2_SLI_LATENCY_MS = forfeited.previousLatencyMs;
    }
    await setSliAttestationForDeal(context, deal);
  });
  await runStep(context, "wait for post-forfeiture settlement window", () => waitForSettlementWindow(context, deal, rail));
  await runStep(context, "refresh evidence after passing SLI restore", () => refreshEvidenceStatusAndAssertActive(context, active));
  const settlement = await runStep(context, "settle only the post-forfeiture window", async () => {
    const result = await settleRailAndAssertProviderPayout(context, deal, active, rail);
    const service = await contracts(context).dealService(deal.dealId);
    const payment = await contracts(context).dealPayment(deal.dealId);
    assertEqual(result.fromEpoch, forfeited.targetEpoch, "post-forfeiture settlement start cursor");
    assertEqual(result.expectedGross, settlementAmount(
      payment.pricePer32GiBPerMonth,
      billed32GiBUnits(active.committedBytes),
      service.startEpoch,
      forfeited.targetEpoch,
      result.targetEpoch,
    ), "post-forfeiture gross excludes forfeited window");
    if (forfeited.gross <= 0n) {
      throw new Error(`forfeited gross expected positive, got ${forfeited.gross}`);
    }
    return result;
  });
  await runStep(context, "prove repeated settlement at same target pays zero", () =>
    settleRailAgainAtSameTargetAndAssertNoPayout(context, rail, settlement.targetEpoch)
  );
}
