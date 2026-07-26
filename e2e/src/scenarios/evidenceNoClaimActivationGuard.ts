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
  finishDataCapPostingAndAssertAllocated,
  generatePiece,
  submitDataCapAllocation
} from "../flows/datacap.js";
import {
  expectActivationWithoutClaimCoverageToStayAccepted,
  submitEvidenceBatchAndAssertNoClaimCoverage
} from "../flows/evidence.js";

export async function runEvidenceNoClaimActivationGuard(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer", () => registerDevnetProviderAndOffer(context));
  const deal = await runStep(context, "propose accepted deal", () => proposeDealAndAssertAccepted(context, offer));
  const validator = await runStep(context, "deploy validator", () => createValidatorForDeal(context, deal));
  await runStep(context, "deposit and approve validator operator", () => depositAndApproveValidatorOperator(context, deal, validator));
  const rail = await runStep(context, "create prepared rail", () => createPreparedRailAndAssertRate(context, deal, validator));
  const piece = await runStep(context, "generate piece", () => generatePiece(context));
  await runStep(context, "submit DataCap allocation without provider claim", () => submitDataCapAllocation(context, deal, piece));
  await runStep(context, "finish DataCap posting", () => finishDataCapPostingAndAssertAllocated(context, deal));
  await runStep(context, "submit evidence batch with no claim coverage", () =>
    submitEvidenceBatchAndAssertNoClaimCoverage(context, deal)
  );
  await runStep(context, "prove activation without claim coverage stays accepted", () =>
    expectActivationWithoutClaimCoverageToStayAccepted(context, deal, rail)
  );
}
