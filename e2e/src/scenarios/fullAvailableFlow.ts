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
  importPieceAndWaitForProviderClaim,
  submitDataCapAllocation
} from "../flows/datacap.js";
import {
  activateEvidenceAndAssertDealActive,
  submitEvidenceBatchAndAssertClaimCoverage
} from "../flows/evidence.js";
import {
  configureSettlementCadenceForDevnet,
  refreshEvidenceStatusAndAssertActive,
  setSliAttestationForDeal,
  settleRailAndAssertProviderPayout,
  waitForSettlementWindow
} from "../flows/settlement.js";

export async function runFullAvailableFlow(context: ScenarioContext): Promise<void> {
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
  await runStep(context, "set SLI attestation", () => setSliAttestationForDeal(context, deal));
  await runStep(context, "configure settlement cadence", () => configureSettlementCadenceForDevnet(context, deal));
  await runStep(context, "wait for settlement window", () => waitForSettlementWindow(context, deal, rail));
  await runStep(context, "refresh evidence status", () => refreshEvidenceStatusAndAssertActive(context, active));
  await runStep(context, "settle rail", () => settleRailAndAssertProviderPayout(context, deal, active, rail));
}
