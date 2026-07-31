import { assertEqual } from "../assertions.js";
import { contracts } from "../contracts/views.js";
import { Evm } from "../contracts/evm.js";
import { artifactAbis } from "../contracts/abi.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
import { billed32GiBUnits, settlementAmount } from "../expected.js";
import { submitDataCapAllocation, generatePiece, importPieceAndWaitForProviderClaim, finishDataCapPostingAndAssertAllocated } from "../flows/datacap.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import { activateEvidenceAndAssertDealActive, submitEvidenceBatchAndAssertClaimCoverage } from "../flows/evidence.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import { configureSettlementCadenceForDevnet, refreshEvidenceStatusAndAssertActive, setSliAttestationForDeal, settleRailAtEpochAndAssertOutcome } from "../flows/settlement.js";
import { createPreparedRailAndAssertRate, createValidatorForDeal, depositAndApproveValidatorOperator } from "../flows/validatorRail.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";

export async function runDealTermination(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer", () => registerDevnetProviderAndOffer(context));
  const view = contracts(context);
  const capacityBefore = await runStep(context, "snapshot provider capacity before proposal", () => view.providerCapacity(offer.provider));
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
  await runStep(context, "set passing SLI attestation", () => setSliAttestationForDeal(context, deal));
  await runStep(context, "configure settlement cadence", () => configureSettlementCadenceForDevnet(context, deal));
  await runStep(context, "refresh evidence", () => refreshEvidenceStatusAndAssertActive(context, active));
  const serviceBeforeTermination = await view.dealService(deal.dealId);
  await runStep(context, "terminate active deal at the market", async () => {
    const evm = new Evm(context);
    const txHash = await evm.sendWithPrivateKey(
      context.config.identityKeys.porepService,
      context.config.addresses.poRepMarket,
      "terminateDeal(uint256,uint8)",
      [deal.dealId, 70n],
    );
    const service = await view.dealService(deal.dealId);
    assertEqual((await view.deal(deal.dealId)).state, 70n, "terminated deal state");
    assertEqual(service.earlyTerminationEpoch, BigInt(evm.receipt(txHash).blockNumber), "early termination epoch");
    assertEqual(await view.validatorRailStatus(validator.validator), 100n, "terminated validator rail status");
    const capacityAfter = await view.providerCapacity(offer.provider);
    assertEqual(capacityAfter.availableBytes, capacityBefore.availableBytes, "terminated provider available capacity");
    assertEqual(capacityAfter.committedBytes, capacityBefore.committedBytes, "terminated provider committed capacity");
    assertEqual(capacityAfter.pendingBytes, capacityBefore.pendingBytes, "terminated provider pending capacity");
  });
  await runStep(context, "prove repeated termination is rejected without state changes", async () => {
    const evm = new Evm(context);
    const capacityBeforeRetry = await view.providerCapacity(offer.provider);
    const serviceBeforeRetry = await view.dealService(deal.dealId);
    let revertAssertionError: unknown;
    try {
      const error = await expectRevertOnSend(
        evm,
        context.config.identityKeys.porepService,
        context.config.addresses.poRepMarket,
        "terminateDeal(uint256,uint8)",
        [deal.dealId, 70n],
        artifactAbis(context).poRepMarket,
        "DealNotInExpectedState",
      );
      assertEqual(error.args[0], deal.dealId, "repeated termination deal id");
      assertEqual(error.args[1], 70n, "repeated termination current deal state");
      assertEqual(error.args[2], 30n, "repeated termination expected deal state");
    } catch (error) {
      revertAssertionError = error;
    }
    const capacityAfterRetry = await view.providerCapacity(offer.provider);
    assertEqual(capacityAfterRetry.availableBytes, capacityBeforeRetry.availableBytes, "repeated termination available capacity");
    assertEqual(capacityAfterRetry.committedBytes, capacityBeforeRetry.committedBytes, "repeated termination committed capacity");
    assertEqual(capacityAfterRetry.pendingBytes, capacityBeforeRetry.pendingBytes, "repeated termination pending capacity");
    assertEqual(
      (await view.dealService(deal.dealId)).earlyTerminationEpoch,
      serviceBeforeRetry.earlyTerminationEpoch,
      "repeated termination early termination epoch",
    );
    if (revertAssertionError !== undefined) {
      throw revertAssertionError;
    }
  });
  await runStep(context, "settle pre-termination window capped at termination", async () => {
    const service = await view.dealService(deal.dealId);
    const beforeRail = await view.rail(rail.railId);
    const payment = await view.dealPayment(deal.dealId);
    const targetEpoch = new Evm(context).blockNumber() + 1n;
    await new Evm(context).waitForBlock(targetEpoch);
    const expectedGross = settlementAmount(
      payment.pricePer32GiBPerMonth,
      billed32GiBUnits(active.committedBytes),
      serviceBeforeTermination.startEpoch,
      beforeRail.settledUpTo,
      service.earlyTerminationEpoch,
    );
    await settleRailAtEpochAndAssertOutcome(context, deal, rail, targetEpoch, {
      settlementAmount: expectedGross,
      settleUpto: targetEpoch,
      note: "payment limited to deal termination epoch",
    }, targetEpoch);
  });
  await runStep(context, "settle post-termination tail with zero payment", async () => {
    const beforeRail = await view.rail(rail.railId);
    const targetEpoch = new Evm(context).blockNumber() + 1n;
    await new Evm(context).waitForBlock(targetEpoch);
    const marketCursorBefore = (await view.dealService(deal.dealId)).lastSettledEpoch;
    await settleRailAtEpochAndAssertOutcome(context, deal, rail, targetEpoch, {
      settlementAmount: 0n,
      settleUpto: targetEpoch,
      note: "deal terminated",
    }, marketCursorBefore);
    assertEqual((await view.rail(rail.railId)).settledUpTo, targetEpoch, "post-termination rail cursor");
    assertEqual(beforeRail.settledUpTo < targetEpoch, true, "post-termination settlement advances cursor");
  });
}
