import { assertEqual } from "../assertions.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm } from "../contracts/evm.js";
import { contracts, type Account, type Deal, type EvidenceStatus, type Rail } from "../contracts/views.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
import {
  assertDataCapGuardStateUnchanged,
  dataCapBatchCalldata,
  dataCapGuardState,
  type DataCapGuardState,
  finishDataCapPostingAndAssertAllocated,
  generatePiece,
  importPieceAndWaitForProviderClaim,
  submitDataCapAllocation,
} from "../flows/datacap.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import {
  activateEvidenceAndAssertDealActive,
  submitEvidenceBatchAndAssertClaimCoverage,
} from "../flows/evidence.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import {
  configureSettlementCadenceForDevnet,
  refreshEvidenceStatusAndAssertActive,
  settleAccountLockupAtEpoch,
  setSliAttestationForDeal,
  settleRailAndAssertProviderPayout,
  waitForSettlementWindow,
} from "../flows/settlement.js";
import {
  createPreparedRailAndAssertRate,
  createValidatorForDeal,
  depositAndApproveValidatorOperator,
} from "../flows/validatorRail.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";

type ActiveDealSnapshot = {
  deal: Deal;
  payment: { token: string; payee: string; pricePer32GiBPerMonth: bigint };
  service: {
    startEpoch: bigint;
    endEpoch: bigint;
    earlyTerminationEpoch: bigint;
    minSettlementEpochs: bigint;
    lastSettledEpoch: bigint;
  };
  evidence: EvidenceStatus;
  rail: Rail;
  payer: Account;
  payee: Account;
  dataCap: DataCapGuardState;
};

export async function runAdapterDisable(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer", () =>
    registerDevnetProviderAndOffer(context),
  );
  const deal = await runStep(context, "propose accepted deal", () =>
    proposeDealAndAssertAccepted(context, offer),
  );
  const validator = await runStep(context, "deploy validator", () =>
    createValidatorForDeal(context, deal),
  );
  await runStep(context, "deposit and approve validator operator", () =>
    depositAndApproveValidatorOperator(context, deal, validator),
  );
  const rail = await runStep(context, "create prepared rail", () =>
    createPreparedRailAndAssertRate(context, deal, validator),
  );
  const piece = await runStep(context, "generate piece", () => generatePiece(context));
  const allocation = await runStep(context, "submit DataCap allocation", () =>
    submitDataCapAllocation(context, deal, piece),
  );
  await runStep(context, "import piece and wait for provider claim", () =>
    importPieceAndWaitForProviderClaim(context, allocation),
  );
  await runStep(context, "finish DataCap posting", () =>
    finishDataCapPostingAndAssertAllocated(context, deal),
  );
  await runStep(context, "submit evidence batch", () =>
    submitEvidenceBatchAndAssertClaimCoverage(context, deal),
  );
  const active = await runStep(context, "activate evidence", () =>
    activateEvidenceAndAssertDealActive(context, deal, rail),
  );
  await runStep(context, "set passing SLI attestation", () =>
    setSliAttestationForDeal(context, deal),
  );
  await runStep(context, "configure settlement cadence", () =>
    configureSettlementCadenceForDevnet(context, deal),
  );
  await runStep(context, "refresh active deal evidence", () =>
    refreshEvidenceStatusAndAssertActive(context, active),
  );

  const blockedDeal = await runStep(context, "propose second accepted deal for disabled submission", () =>
    proposeDealAndAssertAccepted(context, offer),
  );
  const blockedValidator = await runStep(context, "deploy validator for disabled submission", () =>
    createValidatorForDeal(context, blockedDeal),
  );
  await runStep(context, "deposit and approve disabled submission validator operator", () =>
    depositAndApproveValidatorOperator(context, blockedDeal, blockedValidator),
  );
  await runStep(context, "create prepared rail for disabled submission", () =>
    createPreparedRailAndAssertRate(context, blockedDeal, blockedValidator),
  );
  const blockedPiece = await runStep(context, "generate piece for disabled submission", () =>
    generatePiece(context),
  );

  const view = contracts(context);
  const beforeDisable = await runStep(context, "snapshot active deal before adapter disable", () =>
    activeDealSnapshot(context, deal.dealId),
  );
  const blockedBeforeDisable = await runStep(context, "snapshot accepted submission deal before adapter disable", () =>
    dataCapGuardState(context, blockedDeal.dealId),
  );
  const adapterAbi = artifactAbis(context).dataCapEvidenceAdapter;
  const evm = new Evm(context);

  await runStep(context, "disable adapter as its deployed admin", async () => {
    const adminRole = await evm.contract(context.config.addresses.dataCapEvidenceAdapter, adapterAbi).DEFAULT_ADMIN_ROLE();
    const adminAddress = evm.addressForPrivateKey(context.config.identityKeys.deployer);
    const hasAdminRole = await evm.contract(context.config.addresses.dataCapEvidenceAdapter, adapterAbi)
      .hasRole(adminRole, adminAddress);
    assertEqual(hasAdminRole, true, "deployer has DataCap adapter admin role");

    await evm.sendWithPrivateKey(
      context.config.identityKeys.deployer,
      context.config.addresses.dataCapEvidenceAdapter,
      "disableAdapter()",
    );
    assertEqual(await view.dataCapOperational(), false, "adapter is non-operational after disable");
    await assertExistingDealUnchangedExceptOperational(context, deal.dealId, beforeDisable, "state after adapter disable");
  });

  await runStep(context, "reject new DataCap submission after adapter disable", async () => {
    const calldata = dataCapBatchCalldata(context, {
      provider: blockedDeal.deal.provider,
      pieceSize: blockedPiece.pieceSize,
      dealId: blockedDeal.dealId,
      pieceCidHex: blockedPiece.pieceCidHex,
    });
    const error = await expectRevertOnSend(
      evm,
      context.config.privateKeyTest,
      context.config.addresses.dataCapEvidenceAdapter,
      calldata,
      [],
      adapterAbi,
      "AdapterNotOperational",
    );
    assertEqual(error.args.length, 0, "AdapterNotOperational error arguments");
    await assertExistingDealUnchangedExceptOperational(context, deal.dealId, beforeDisable, "state after disabled adapter submission");
    assertDataCapGuardStateUnchanged(
      await dataCapGuardState(context, blockedDeal.dealId),
      disabledDataCapState(blockedBeforeDisable),
      "accepted deal state after disabled adapter submission",
    );
  });

  await runStep(context, "reject a second adapter disable", async () => {
    const error = await expectRevertOnSend(
      evm,
      context.config.identityKeys.deployer,
      context.config.addresses.dataCapEvidenceAdapter,
      "disableAdapter()",
      [],
      adapterAbi,
      "AdapterAlreadyNonOperational",
    );
    assertEqual(error.args.length, 0, "AdapterAlreadyNonOperational error arguments");
    await assertExistingDealUnchangedExceptOperational(context, deal.dealId, beforeDisable, "state after second disable");
  });

  await runStep(context, "settle existing active deal after adapter disable", async () => {
    await waitForSettlementWindow(context, deal, rail);
    const settlement = await settleRailAndAssertProviderPayout(context, deal, active, rail);
    const settlementBlock = BigInt(new Evm(context).receipt(settlement.txHash).blockNumber);
    const expectedPayer = expectedPayerAfterSettlement(
      beforeDisable.payer,
      beforeDisable.rail.paymentRate,
      settlement.fromEpoch,
      settlement.targetEpoch,
      settlement.expectedGross,
      settlementBlock,
    );
    const expectedPayee = expectedPayeeAfterSettlement(beforeDisable.payee, settlement.paidAmount);
    const after = await activeDealSnapshot(context, deal.dealId);
    assertDealEqual(after.deal, beforeDisable.deal, "deal after post-disable settlement");
    assertPaymentEqual(after.payment, beforeDisable.payment, "payment after post-disable settlement");
    assertEvidenceEqual(after.evidence, beforeDisable.evidence, "evidence after post-disable settlement");
    assertEqual(after.service.startEpoch, beforeDisable.service.startEpoch, "service start epoch after post-disable settlement");
    assertEqual(after.service.endEpoch, beforeDisable.service.endEpoch, "service end epoch after post-disable settlement");
    assertEqual(after.service.earlyTerminationEpoch, beforeDisable.service.earlyTerminationEpoch, "service termination epoch after post-disable settlement");
    assertEqual(after.service.minSettlementEpochs, beforeDisable.service.minSettlementEpochs, "service cadence after post-disable settlement");
    assertEqual(after.service.lastSettledEpoch, settlement.targetEpoch, "service cursor after post-disable settlement");
    assertRailUnchangedExceptCursor(after.rail, beforeDisable.rail, settlement.targetEpoch, "rail after post-disable settlement");
    assertAccountEqual(after.payer, expectedPayer, "payer after post-disable settlement");
    assertAccountEqual(after.payee, expectedPayee, "payee after post-disable settlement");
    assertDataCapGuardStateUnchanged(
      after.dataCap,
      {
        ...disabledDataCapState(beforeDisable.dataCap),
        railSettledUpTo: settlement.targetEpoch,
      },
      "DataCap state after post-disable settlement",
    );
    assertEqual(after.dataCap.operational, false, "adapter remains non-operational after settlement");
  });
}

async function activeDealSnapshot(context: ScenarioContext, dealId: bigint): Promise<ActiveDealSnapshot> {
  const view = contracts(context);
  const deal = await view.deal(dealId);
  return {
    deal,
    payment: await view.dealPayment(dealId),
    service: await view.dealService(dealId),
    evidence: await view.evidenceStatus(dealId),
    rail: await view.rail(deal.railId),
    payer: await view.account(deal.client),
    payee: await view.account((await view.dealPayment(dealId)).payee),
    dataCap: await dataCapGuardState(context, dealId),
  };
}

async function assertExistingDealUnchangedExceptOperational(
  context: ScenarioContext,
  dealId: bigint,
  before: ActiveDealSnapshot,
  label: string,
): Promise<void> {
  const after = await activeDealSnapshot(context, dealId);
  assertDealEqual(after.deal, before.deal, `${label} deal`);
  assertPaymentEqual(after.payment, before.payment, `${label} payment`);
  assertServiceEqual(after.service, before.service, `${label} service`);
  assertEvidenceEqual(after.evidence, before.evidence, `${label} evidence`);
  assertRailEqual(after.rail, before.rail, `${label} rail`);
  assertAccountEqual(after.payer, before.payer, `${label} payer`);
  assertAccountEqual(after.payee, before.payee, `${label} payee`);
  assertDataCapGuardStateUnchanged(
    after.dataCap,
    disabledDataCapState(before.dataCap),
    `${label} DataCap`,
  );
  assertEqual(after.dataCap.operational, false, `${label} adapter operational`);
}

function assertDealEqual(actual: Deal, expected: Deal, label: string): void {
  assertEqual(actual.id, expected.id, `${label} id`);
  assertEqual(actual.client, expected.client, `${label} client`);
  assertEqual(actual.provider, expected.provider, `${label} provider`);
  assertEqual(actual.offerId, expected.offerId, `${label} offer id`);
  assertEqual(actual.state, expected.state, `${label} state`);
  assertEqual(actual.evidenceAdapter, expected.evidenceAdapter, `${label} evidence adapter`);
  assertEqual(actual.dealType, expected.dealType, `${label} deal type`);
  assertEqual(actual.validator, expected.validator, `${label} validator`);
  assertEqual(actual.railId, expected.railId, `${label} rail id`);
  assertEqual(actual.proposedAtEpoch, expected.proposedAtEpoch, `${label} proposed epoch`);
}

function assertPaymentEqual(
  actual: ActiveDealSnapshot["payment"],
  expected: ActiveDealSnapshot["payment"],
  label: string,
): void {
  assertEqual(actual.token, expected.token, `${label} token`);
  assertEqual(actual.payee, expected.payee, `${label} payee`);
  assertEqual(actual.pricePer32GiBPerMonth, expected.pricePer32GiBPerMonth, `${label} monthly price`);
}

function assertServiceEqual(
  actual: ActiveDealSnapshot["service"],
  expected: ActiveDealSnapshot["service"],
  label: string,
): void {
  assertEqual(actual.startEpoch, expected.startEpoch, `${label} start epoch`);
  assertEqual(actual.endEpoch, expected.endEpoch, `${label} end epoch`);
  assertEqual(actual.earlyTerminationEpoch, expected.earlyTerminationEpoch, `${label} termination epoch`);
  assertEqual(actual.minSettlementEpochs, expected.minSettlementEpochs, `${label} settlement cadence`);
  assertEqual(actual.lastSettledEpoch, expected.lastSettledEpoch, `${label} settled epoch`);
}

function assertEvidenceEqual(actual: EvidenceStatus, expected: EvidenceStatus, label: string): void {
  assertEqual(actual.activeCoveredBytes, expected.activeCoveredBytes, `${label} active covered bytes`);
  assertEqual(actual.lastEvidenceRefreshEpoch, expected.lastEvidenceRefreshEpoch, `${label} last refresh epoch`);
  assertEqual(actual.reasonCode, expected.reasonCode, `${label} reason code`);
  assertEqual(actual.result, expected.result, `${label} result`);
  assertEqual(actual.checkedClaims, expected.checkedClaims, `${label} checked claims`);
  assertEqual(actual.totalClaims, expected.totalClaims, `${label} total claims`);
}

function assertRailEqual(actual: Rail, expected: Rail, label: string): void {
  assertRailUnchangedExceptCursor(actual, expected, expected.settledUpTo, label);
}

function assertRailUnchangedExceptCursor(actual: Rail, expected: Rail, settledUpTo: bigint, label: string): void {
  assertEqual(actual.token, expected.token, `${label} token`);
  assertEqual(actual.from, expected.from, `${label} payer`);
  assertEqual(actual.to, expected.to, `${label} payee`);
  assertEqual(actual.operator, expected.operator, `${label} operator`);
  assertEqual(actual.validator, expected.validator, `${label} validator`);
  assertEqual(actual.paymentRate, expected.paymentRate, `${label} payment rate`);
  assertEqual(actual.settledUpTo, settledUpTo, `${label} settled cursor`);
  assertEqual(actual.endEpoch, expected.endEpoch, `${label} end epoch`);
  assertEqual(actual.commissionRateBps, expected.commissionRateBps, `${label} commission rate`);
  assertEqual(actual.serviceFeeRecipient, expected.serviceFeeRecipient, `${label} service fee recipient`);
}

function assertAccountEqual(actual: Account, expected: Account, label: string): void {
  assertEqual(actual.funds, expected.funds, `${label} funds`);
  assertEqual(actual.lockupCurrent, expected.lockupCurrent, `${label} lockup current`);
  assertEqual(actual.lockupRate, expected.lockupRate, `${label} lockup rate`);
  assertEqual(actual.lockupLastSettledAt, expected.lockupLastSettledAt, `${label} lockup settled at`);
}

function expectedPayerAfterSettlement(
  before: Account,
  paymentRate: bigint,
  fromEpoch: bigint,
  settledUpTo: bigint,
  grossPayment: bigint,
  settlementBlock: bigint,
): Account {
  const lockupBeforePayment = settleAccountLockupAtEpoch(before, settlementBlock);
  const settledDuration = settledUpTo - fromEpoch;
  const releasedLockup = paymentRate * settledDuration;
  if (lockupBeforePayment.funds < grossPayment) {
    throw new Error(`expected payer funds ${lockupBeforePayment.funds} below gross payment ${grossPayment}`);
  }
  if (lockupBeforePayment.lockupCurrent < releasedLockup) {
    throw new Error(
      `expected payer lockup ${lockupBeforePayment.lockupCurrent} below released lockup ${releasedLockup}`,
    );
  }
  return {
    funds: lockupBeforePayment.funds - grossPayment,
    lockupCurrent: lockupBeforePayment.lockupCurrent - releasedLockup,
    lockupRate: lockupBeforePayment.lockupRate,
    lockupLastSettledAt: lockupBeforePayment.lockupLastSettledAt,
  };
}

function expectedPayeeAfterSettlement(before: Account, netPayment: bigint): Account {
  return {
    funds: before.funds + netPayment,
    lockupCurrent: before.lockupCurrent,
    lockupRate: before.lockupRate,
    lockupLastSettledAt: before.lockupLastSettledAt,
  };
}

function disabledDataCapState(state: DataCapGuardState): DataCapGuardState {
  return {
    ...state,
    allocationIds: [...state.allocationIds],
    claimIds: [...state.claimIds],
    operational: false,
  };
}
