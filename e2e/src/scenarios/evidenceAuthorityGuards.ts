import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import {
  expectDirectDataCapAdapterRefreshToFail
} from "../flows/accessControl.js";
import {
  finishDataCapPostingAndAssertAllocated,
  generatePiece,
  importPieceAndWaitForProviderClaim,
  submitDataCapAllocation
} from "../flows/datacap.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import { activateEvidenceAndAssertDealActive, submitEvidenceBatchAndAssertClaimCoverage } from "../flows/evidence.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import { refreshEvidenceStatusAndAssertActive } from "../flows/settlement.js";
import {
  createPreparedRailAndAssertRate,
  createValidatorForDeal,
  depositAndApproveValidatorOperator
} from "../flows/validatorRail.js";

export async function runEvidenceAuthorityGuards(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer for evidence authority guard", () =>
    registerDevnetProviderAndOffer(context)
  );
  const deal = await runStep(context, "propose accepted deal for evidence authority guard", () =>
    proposeDealAndAssertAccepted(context, offer)
  );
  const validator = await runStep(context, "deploy validator for evidence authority guard", () => createValidatorForDeal(context, deal));
  await runStep(context, "deposit and approve evidence authority validator operator", () =>
    depositAndApproveValidatorOperator(context, deal, validator)
  );
  const rail = await runStep(context, "create prepared rail for evidence authority guard", () =>
    createPreparedRailAndAssertRate(context, deal, validator)
  );
  const piece = await runStep(context, "generate piece for evidence authority guard", () => generatePiece(context));
  const allocation = await runStep(context, "submit DataCap allocation for evidence authority guard", () =>
    submitDataCapAllocation(context, deal, piece)
  );
  await runStep(context, "import piece and wait for provider claim for evidence authority guard", () =>
    importPieceAndWaitForProviderClaim(context, allocation)
  );
  await runStep(context, "finish DataCap posting for evidence authority guard", () =>
    finishDataCapPostingAndAssertAllocated(context, deal)
  );
  await runStep(context, "submit evidence batch for evidence authority guard", () =>
    submitEvidenceBatchAndAssertClaimCoverage(context, deal)
  );
  const active = await runStep(context, "activate evidence for evidence authority guard", () =>
    activateEvidenceAndAssertDealActive(context, deal, rail)
  );
  await runStep(context, "refresh evidence as independent caller", () =>
    refreshEvidenceStatusAndAssertActive(context, active)
  );
  await runStep(context, "prove direct DataCap adapter refresh fails", () => expectDirectDataCapAdapterRefreshToFail(context, deal));
}
