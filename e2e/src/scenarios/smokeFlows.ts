import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import {
  createPreparedRailAndAssertRate,
  createValidatorForDeal,
  depositAndApproveValidatorOperator
} from "../flows/validatorRail.js";

export async function runProposalSmoke(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer", () => registerDevnetProviderAndOffer(context));
  await runStep(context, "propose accepted deal", () => proposeDealAndAssertAccepted(context, offer));
}

export async function runValidatorRailSmoke(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer", () => registerDevnetProviderAndOffer(context));
  const deal = await runStep(context, "propose accepted deal", () => proposeDealAndAssertAccepted(context, offer));
  const validator = await runStep(context, "deploy validator", () => createValidatorForDeal(context, deal));
  await runStep(context, "deposit and approve validator operator", () => depositAndApproveValidatorOperator(context, deal, validator));
  await runStep(context, "create prepared rail", () => createPreparedRailAndAssertRate(context, deal, validator));
}
