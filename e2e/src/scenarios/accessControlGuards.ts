import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import {
  expectDirectDealSettlementValidationToFail,
  expectUnauthorizedProviderCapacityWritesToFail,
  expectUnauthorizedSettlementCadenceUpdateToFail,
  expectUnauthorizedSliUpdateToFail,
  expectUnauthorizedUpgradeToFail,
} from "../flows/accessControl.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";

export async function runAccessControlGuards(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer", () => registerDevnetProviderAndOffer(context));
  const deal = await runStep(context, "propose accepted deal", () => proposeDealAndAssertAccepted(context, offer));
  await runStep(context, "prove unauthorized settlement cadence update fails", () =>
    expectUnauthorizedSettlementCadenceUpdateToFail(context, deal)
  );
  await runStep(context, "prove unauthorized SLI update fails", () => expectUnauthorizedSliUpdateToFail(context, deal));
  await runStep(context, "prove unauthorized provider capacity writes fail", () =>
    expectUnauthorizedProviderCapacityWritesToFail(context, deal));
  await runStep(context, "prove direct settlement validation fails", () =>
    expectDirectDealSettlementValidationToFail(context, deal));
  await runStep(context, "prove unauthorized upgrade fails", () =>
    expectUnauthorizedUpgradeToFail(context));
}
