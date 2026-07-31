import { assertEqual } from "../assertions.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm } from "../contracts/evm.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
import { contracts } from "../contracts/views.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import { activateEvidenceAndAssertDealActive } from "../flows/evidence.js";
import {
  finishDataCapPostingAndAssertAllocated,
  assertDataCapGuardStateUnchanged,
  dataCapGuardState,
  importAllocationsAndWaitForProviderClaims,
  generatePiece,
  submitEvidenceAllocationBatchesAndAssertClaimCoverage,
  submitDataCapAllocation,
  submitMultipleDataCapAllocations
} from "../flows/datacap.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import {
  createPreparedRailAndAssertRate,
  createValidatorForDeal,
  depositAndApproveValidatorOperator
} from "../flows/validatorRail.js";
import {
  configureSettlementCadenceForDevnet,
  refreshEvidenceStatusAndAssertPartial,
  refreshEvidenceStatusWithBatchAndAssertActive,
  setSliAttestationForDeal,
  settleRailAndAssertProviderPayout,
  waitForSettlementWindow
} from "../flows/settlement.js";

export async function runMultiClaimEvidenceBatches(context: ScenarioContext): Promise<void> {
  context.config.env.V2_REQUESTED_SIZE_BYTES = "4194304";
  context.config.env.V2_EVIDENCE_BATCH_SIZE = "1";
  context.config.env.V2_EVIDENCE_REFRESH_BATCH_SIZE = "1";

  const offer = await runStep(context, "register provider and offer for multi-claim deal", () =>
    registerDevnetProviderAndOffer(context)
  );
  await runStep(context, "reject finishing a short DataCap allocation", () =>
    expectShortDataCapAllocationToFail(context, offer)
  );
  const deal = await runStep(context, "propose accepted multi-claim deal", () => proposeDealAndAssertAccepted(context, offer));
  const validator = await runStep(context, "deploy validator for multi-claim deal", () => createValidatorForDeal(context, deal));
  await runStep(context, "deposit and approve multi-claim validator operator", () =>
    depositAndApproveValidatorOperator(context, deal, validator)
  );
  const rail = await runStep(context, "create prepared rail for multi-claim deal", () =>
    createPreparedRailAndAssertRate(context, deal, validator)
  );
  const allocations = await runStep(context, "submit multiple DataCap allocations", () =>
    submitMultipleDataCapAllocations(context, deal, 2)
  );
  if (allocations.totalPieceSize !== deal.requestedSizeBytes) {
    throw new Error(`multi-claim pieces must exactly cover requested size: pieces=${allocations.totalPieceSize}, requested=${deal.requestedSizeBytes}`);
  }
  await runStep(context, "import allocations and wait for provider claims", () =>
    importAllocationsAndWaitForProviderClaims(context, allocations)
  );
  await runStep(context, "finish DataCap posting after multiple allocations", () =>
    finishDataCapPostingAndAssertAllocated(context, deal)
  );
  await runStep(context, "submit evidence allocation batches", () =>
    submitEvidenceAllocationBatchesAndAssertClaimCoverage(context, deal, allocations.allocationIds.length, 1n)
  );
  const active = await runStep(context, "activate multi-claim evidence", () => activateEvidenceAndAssertDealActive(context, deal, rail));
  await runStep(context, "set SLI attestation for multi-claim settlement", () => setSliAttestationForDeal(context, deal));
  await runStep(context, "configure settlement cadence for multi-claim deal", () =>
    configureSettlementCadenceForDevnet(context, deal)
  );
  await runStep(context, "wait for settlement window for multi-claim deal", () => waitForSettlementWindow(context, deal, rail));
  await runStep(context, "assert partial evidence refresh and refresh evidence one claim at a time", () =>
    refreshEvidenceStatusAndAssertPartial(context, active, 1n)
  );
  await runStep(context, "assert final active evidence refresh", () => refreshEvidenceStatusWithBatchAndAssertActive(context, active, 1n));
  await runStep(context, "settle multi-claim rail", () => settleRailAndAssertProviderPayout(context, deal, active, rail));
}

async function expectShortDataCapAllocationToFail(
  context: ScenarioContext,
  offer: Awaited<ReturnType<typeof registerDevnetProviderAndOffer>>,
): Promise<void> {
  const view = contracts(context);
  const shortDeal = await proposeDealAndAssertAccepted(context, offer);
  const validator = await createValidatorForDeal(context, shortDeal);
  await depositAndApproveValidatorOperator(context, shortDeal, validator);
  await createPreparedRailAndAssertRate(context, shortDeal, validator);
  const piece = generatePiece(context);
  assertEqual(piece.pieceSize < shortDeal.requestedSizeBytes, true, "short allocation piece is below requested bytes");
  await submitDataCapAllocation(context, shortDeal, piece);

  const before = await dataCapGuardState(context, shortDeal.dealId);
  const error = await expectRevertOnSend(
    new Evm(context),
    context.config.privateKeyTest,
    context.config.addresses.dataCapEvidenceAdapter,
    "finishDataCapPosting(uint256)",
    [shortDeal.dealId],
    artifactAbis(context).dataCapEvidenceAdapter,
    "InvalidAllocatedBytes",
  );
  assertEqual(error.args.length, 0, "InvalidAllocatedBytes error arguments");

  const after = await dataCapGuardState(context, shortDeal.dealId);
  assertDataCapGuardStateUnchanged(after, before, "state after InvalidAllocatedBytes");
  assertEqual(after.dealState, 20n, "short allocation deal remains ACCEPTED");
  assertEqual(after.postingFinished, false, "short allocation posting remains unfinished");
  assertEqual(after.allocatedBytes, piece.pieceSize, "short allocation bytes remain recorded");
  assertEqual(after.providerCommittedBytes, before.providerCommittedBytes, "short allocation provider committed bytes unchanged");
  assertEqual(after.providerAvailableBytes, before.providerAvailableBytes, "short allocation provider available bytes unchanged");
  assertEqual(after.providerPendingBytes, before.providerPendingBytes, "short allocation provider pending bytes unchanged");
  assertEqual((await view.dealCapacity(shortDeal.dealId)).committedBytes, 0n, "short allocation deal committed bytes remain zero");
}
