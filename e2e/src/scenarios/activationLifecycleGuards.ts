import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import {
  createPreparedRailAndAssertRate,
  createValidatorForDeal,
  depositAndApproveValidatorOperator
} from "../flows/validatorRail.js";
import {
  expectDataCapAllocationWithoutPreparedRailToFail,
  finishDataCapPostingAndAssertAllocated,
  generatePiece,
  importPieceAndWaitForProviderClaim,
  submitDataCapAllocation
} from "../flows/datacap.js";
import {
  activateEvidenceAndAssertDealActive,
  expectDoubleActivationToFail,
  submitEvidenceBatchAndAssertClaimCoverage
} from "../flows/evidence.js";

export async function runActivationLifecycleGuards(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer", () => registerDevnetProviderAndOffer(context));

  const noRailDeal = await runStep(context, "propose no-rail accepted deal", () => proposeDealAndAssertAccepted(context, offer));
  await runStep(context, "deploy validator without prepared rail", () => createValidatorForDeal(context, noRailDeal));
  const noRailPiece = await runStep(context, "generate no-rail piece", () => generatePiece(context));
  await runStep(context, "prove DataCap allocation without prepared rail fails", () =>
    expectDataCapAllocationWithoutPreparedRailToFail(context, noRailDeal, noRailPiece)
  );

  const activeDeal = await runStep(context, "propose double-activation deal", () => proposeDealAndAssertAccepted(context, offer));
  const activeValidator = await runStep(context, "deploy double-activation validator", () => createValidatorForDeal(context, activeDeal));
  await runStep(context, "deposit and approve double-activation validator operator", () =>
    depositAndApproveValidatorOperator(context, activeDeal, activeValidator)
  );
  const activeRail = await runStep(context, "create double-activation prepared rail", () =>
    createPreparedRailAndAssertRate(context, activeDeal, activeValidator)
  );
  const activePiece = await runStep(context, "generate double-activation piece", () => generatePiece(context));
  const activeAllocation = await runStep(context, "submit double-activation DataCap allocation", () =>
    submitDataCapAllocation(context, activeDeal, activePiece)
  );
  await runStep(context, "import double-activation piece and wait for provider claim", () =>
    importPieceAndWaitForProviderClaim(context, activeAllocation)
  );
  await runStep(context, "finish double-activation DataCap posting", () => finishDataCapPostingAndAssertAllocated(context, activeDeal));
  await runStep(context, "submit double-activation evidence batch", () => submitEvidenceBatchAndAssertClaimCoverage(context, activeDeal));
  const active = await runStep(context, "activate double-activation deal", () =>
    activateEvidenceAndAssertDealActive(context, activeDeal, activeRail)
  );
  await runStep(context, "prove double activation fails", () => expectDoubleActivationToFail(context, active));
}
