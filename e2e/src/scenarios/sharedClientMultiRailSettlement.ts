import { assertEqual } from "../assertions.js";
import { contracts, type Account } from "../contracts/views.js";
import { Evm } from "../contracts/evm.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import {
  finishDataCapPostingAndAssertAllocated,
  generatePiece,
  importPieceAndWaitForProviderClaim,
  submitDataCapAllocation
} from "../flows/datacap.js";
import { proposeDealAndAssertAccepted, type AcceptedDeal } from "../flows/deal.js";
import { activateEvidenceAndAssertDealActive, submitEvidenceBatchAndAssertClaimCoverage, type ActiveDeal } from "../flows/evidence.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import {
  assertSharedPayerAccountCoversBothRails,
  configureSettlementCadenceForDevnet,
  refreshEvidenceStatusAndAssertActive,
  setSliAttestationForDeal,
  settleRailAgainAtSameTargetAndAssertNoPayout,
  settleRailAndAssertOnlySelectedRailAdvanced,
  waitForSettlementWindow
} from "../flows/settlement.js";
import {
  createPreparedRailAndAssertRate,
  createValidatorForDeal,
  depositAndApproveValidatorOperator,
  type PreparedRail
} from "../flows/validatorRail.js";

type SettleableDeal = {
  deal: AcceptedDeal;
  active: ActiveDeal;
  rail: PreparedRail;
};

export async function runSharedClientMultiRailSettlement(context: ScenarioContext): Promise<void> {
  const payerBaseline = await runStep(context, "snapshot payer account before shared-client rails", () =>
    snapshotSharedClientPayerBaseline(context)
  );
  const first = await createSettleableSharedClientDeal(context, {
    label: "first",
    dealStepName: "create first shared-client deal",
    providerPayee: new Evm(context).spAddress
  });
  const second = await createSettleableSharedClientDeal(context, {
    label: "second",
    dealStepName: "create second shared-client deal",
    providerPayee: "0x000000000000000000000000000000000000bEEF"
  });

  await runStep(context, "snapshot payer account before settlement", () =>
    assertSharedPayerAccountCoversBothRails(context, first.rail, second.rail, payerBaseline)
  );
  const firstSettlement = await runStep(context, "settle first rail and assert only first rail advances", () =>
    settleRailAndAssertOnlySelectedRailAdvanced(context, first.deal, first.active, first.rail, second.rail)
  );
  await runStep(context, "settle second rail and assert only second rail advances", () =>
    settleRailAndAssertOnlySelectedRailAdvanced(context, second.deal, second.active, second.rail, first.rail)
  );
  await runStep(context, "assert repeated settlement does not leak payout", async () => {
    const view = contracts(context);
    const otherRailBefore = await view.rail(second.rail.railId);
    const otherPayeeBefore = await view.account(otherRailBefore.to);
    await settleRailAgainAtSameTargetAndAssertNoPayout(context, first.rail, firstSettlement.targetEpoch);
    const otherRailAfter = await view.rail(second.rail.railId);
    const otherPayeeAfter = await view.account(otherRailAfter.to);
    assertEqual(otherRailAfter.settledUpTo, otherRailBefore.settledUpTo, "second rail settledUpTo after repeated first settlement");
    assertEqual(otherPayeeAfter.funds, otherPayeeBefore.funds, "second payee funds after repeated first settlement");
  });
}

async function snapshotSharedClientPayerBaseline(context: ScenarioContext): Promise<Account> {
  const evm = new Evm(context);
  const account = await contracts(context).account(evm.signerAddress);
  context.state.set("SHARED_PAYER_BASELINE", evm.signerAddress);
  context.state.set("SHARED_PAYER_BASELINE_FUNDS", account.funds);
  context.state.set("SHARED_PAYER_BASELINE_LOCKUP_CURRENT", account.lockupCurrent);
  context.state.set("SHARED_PAYER_BASELINE_LOCKUP_RATE", account.lockupRate);
  context.state.set("SHARED_PAYER_BASELINE_LOCKUP_LAST_SETTLED_AT", account.lockupLastSettledAt);
  console.log("=== Shared-client payer baseline ===");
  console.log(`  Payer: ${evm.signerAddress}`);
  console.log(`  Funds: ${account.funds}`);
  console.log(`  Lockup current: ${account.lockupCurrent}`);
  console.log(`  Lockup rate: ${account.lockupRate}`);
  console.log(`  Lockup last settled at: ${account.lockupLastSettledAt}`);
  return account;
}

async function createSettleableSharedClientDeal(
  context: ScenarioContext,
  input: { label: "first" | "second"; dealStepName: string; providerPayee: string }
): Promise<SettleableDeal> {
  context.config.env.V2_PROVIDER_PAYEE = input.providerPayee;
  const label = input.label;
  const offer = await runStep(context, `register provider and offer for ${label} shared-client deal`, () =>
    registerDevnetProviderAndOffer(context)
  );
  const deal = await runStep(context, input.dealStepName, () => proposeDealAndAssertAccepted(context, offer));
  const validator = await runStep(context, `deploy validator for ${label} shared-client deal`, () =>
    createValidatorForDeal(context, deal)
  );
  await runStep(context, `deposit and approve validator operator for ${label} shared-client deal`, () =>
    depositAndApproveValidatorOperator(context, deal, validator)
  );
  const rail = await runStep(context, `create prepared rail for ${label} shared-client deal`, () =>
    createPreparedRailAndAssertRate(context, deal, validator)
  );
  const piece = await runStep(context, `generate piece for ${label} shared-client deal`, () => generatePiece(context));
  const allocation = await runStep(context, `submit DataCap allocation for ${label} shared-client deal`, () =>
    submitDataCapAllocation(context, deal, piece)
  );
  await runStep(context, `import piece and wait for provider claim for ${label} shared-client deal`, () =>
    importPieceAndWaitForProviderClaim(context, allocation)
  );
  await runStep(context, `finish DataCap posting for ${label} shared-client deal`, () =>
    finishDataCapPostingAndAssertAllocated(context, deal)
  );
  await runStep(context, `submit evidence batch for ${label} shared-client deal`, () =>
    submitEvidenceBatchAndAssertClaimCoverage(context, deal)
  );
  const active = await runStep(context, `activate evidence for ${label} shared-client deal`, () =>
    activateEvidenceAndAssertDealActive(context, deal, rail)
  );
  await runStep(context, `set SLI attestation for ${label} shared-client deal`, () => setSliAttestationForDeal(context, deal));
  await runStep(context, `configure settlement cadence for ${label} shared-client deal`, () =>
    configureSettlementCadenceForDevnet(context, deal)
  );
  await runStep(context, `wait for settlement window for ${label} shared-client deal`, () => waitForSettlementWindow(context, deal, rail));
  await runStep(context, `refresh evidence status for ${label} shared-client deal`, () =>
    refreshEvidenceStatusAndAssertActive(context, active)
  );
  return { deal, active, rail };
}
