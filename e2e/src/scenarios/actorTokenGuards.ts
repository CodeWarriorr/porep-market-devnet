import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import {
  expectDealProposalWithMismatchedPaymentTokenToFail,
  proposeDealAndAssertAccepted
} from "../flows/deal.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import {
  createValidatorForDeal,
  expectRailCreationWithoutOperatorApprovalToFail
} from "../flows/validatorRail.js";

export async function runActorTokenGuards(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer for actor-token guards", () =>
    registerDevnetProviderAndOffer(context)
  );
  await runStep(context, "prove mismatched payment token proposal fails", () =>
    expectDealProposalWithMismatchedPaymentTokenToFail(context, offer)
  );
  const deal = await runStep(context, "propose accepted deal for wrong-operator guard", () =>
    proposeDealAndAssertAccepted(context, offer)
  );
  const validator = await runStep(context, "deploy validator for wrong-operator guard", () => createValidatorForDeal(context, deal));
  await runStep(context, "prove unapproved validator operator cannot create rail", () =>
    expectRailCreationWithoutOperatorApprovalToFail(context, deal, validator)
  );
}
