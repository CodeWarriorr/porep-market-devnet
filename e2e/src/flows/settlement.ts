import { assertEqual } from "../assertions.js";
import type { ScenarioContext } from "../runtime.js";
import { envBigInt } from "../runtime.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm, firstUint, type TxReceipt } from "../contracts/evm.js";
import { expectCustomError } from "../contracts/reverts.js";
import { contracts, type Account, type DealSlis, type EvidenceStatus } from "../contracts/views.js";
import { requireDevnet } from "../devnet/docker.js";
import type { AcceptedDeal } from "./deal.js";
import type { ActiveDeal } from "./evidence.js";
import type { PreparedRail } from "./validatorRail.js";

export type RailSettledEvent = {
  railId: bigint;
  totalSettledAmount: bigint;
  totalNetPayeeAmount: bigint;
  operatorCommission: bigint;
  networkFee: bigint;
  settledUpTo: bigint;
};

export type SettlementAccounting = {
  payerFundsDelta: bigint;
  payeeFundsDelta: bigint;
  totalSettledAmount: bigint;
  totalNetPayeeAmount: bigint;
  operatorCommission: bigint;
  networkFee: bigint;
};

export async function setSliAttestationForDeal(
  context: ScenarioContext,
  accepted: AcceptedDeal
): Promise<{ txHash: string; lastUpdate: bigint; slis: DealSlis }> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const dealSlis = await view.dealSlis(accepted.dealId);
  const slis = {
    retrievabilityBps: envBigInt(context, "V2_SLI_RETRIEVABILITY_BPS", dealSlis.retrievabilityBps),
    bandwidthBytesPerSecond: envBigInt(context, "V2_SLI_BANDWIDTH_BYTES_PER_SECOND", dealSlis.bandwidthBytesPerSecond),
    latencyMs: envBigInt(context, "V2_SLI_LATENCY_MS", dealSlis.latencyMs),
    indexingAvailabilityPct: envBigInt(context, "V2_SLI_INDEXING_PCT", dealSlis.indexingAvailabilityPct)
  };

  console.log("=== Set V2 SLI attestation ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  SLIOracle: ${context.config.addresses.sliOracle}`);
  console.log(`  Retrievability bps: ${slis.retrievabilityBps}`);
  console.log(`  Bandwidth bytes/s: ${slis.bandwidthBytesPerSecond}`);
  console.log(`  Latency ms: ${slis.latencyMs}`);
  console.log(`  Indexing pct: ${slis.indexingAvailabilityPct}`);

  const txHash = await evm.sendWithPrivateKey(
    context.config.identityKeys.oracle,
    context.config.addresses.sliOracle,
    "setSLI(uint256,(uint16,uint64,uint16,uint8))",
    [accepted.dealId, `(${slis.retrievabilityBps},${slis.bandwidthBytesPerSecond},${slis.latencyMs},${slis.indexingAvailabilityPct})`],
  );
  const attestation = await view.sliAttestation(accepted.dealId);
  if (attestation.lastUpdate <= 0n) throw new Error(`SLI attestation lastUpdate expected > 0, got ${attestation.lastUpdate}`);
  assertEqual(attestation.slis.retrievabilityBps, slis.retrievabilityBps, "SLI retrievability");
  assertEqual(attestation.slis.bandwidthBytesPerSecond, slis.bandwidthBytesPerSecond, "SLI bandwidth");
  assertEqual(attestation.slis.latencyMs, slis.latencyMs, "SLI latency");
  assertEqual(attestation.slis.indexingAvailabilityPct, slis.indexingAvailabilityPct, "SLI indexing");

  context.state.set("SLI_ATTESTATION_TX", txHash);
  context.state.set("SLI_LAST_UPDATE", attestation.lastUpdate);
  context.state.set("SLI_RETRIEVABILITY_BPS", attestation.slis.retrievabilityBps);
  context.state.set("SLI_BANDWIDTH_BYTES_PER_SECOND", attestation.slis.bandwidthBytesPerSecond);
  context.state.set("SLI_LATENCY_MS", attestation.slis.latencyMs);
  context.state.set("SLI_INDEXING_PCT", attestation.slis.indexingAvailabilityPct);
  console.log(`  TX: ${txHash}`);
  console.log(`  Last update epoch: ${attestation.lastUpdate}`);
  console.log("=== V2 SLI attestation set ===");
  return { txHash, lastUpdate: attestation.lastUpdate, slis: attestation.slis };
}

export async function configureSettlementCadenceForDevnet(
  context: ScenarioContext,
  accepted: AcceptedDeal
): Promise<{ txHash: string; minEpochs: bigint }> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const minEpochs = envBigInt(context, "V2_MIN_SETTLEMENT_EPOCHS", 1n);
  if (minEpochs <= 0n) throw new Error(`min settlement epochs must be > 0, got ${minEpochs}`);

  console.log("=== Configure V2 settlement cadence ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Min epochs: ${minEpochs}`);
  console.log("  Mode: devnet scenario configuration through PoRepMarket admin API");

  const txHash = await evm.sendWithPrivateKey(
    context.config.identityKeys.deployer,
    context.config.addresses.poRepMarket,
    "setMinEpochsBetweenSettlements(uint256,uint256)",
    [accepted.dealId, minEpochs],
  );
  const service = await view.dealService(accepted.dealId);
  assertEqual(service.minSettlementEpochs, minEpochs, "min settlement epochs");

  context.state.set("MIN_SETTLEMENT_EPOCHS", service.minSettlementEpochs);
  context.state.set("SET_MIN_SETTLEMENT_EPOCHS_TX", txHash);
  console.log(`  TX: ${txHash}`);
  console.log("=== V2 settlement cadence configured ===");
  return { txHash, minEpochs };
}

export async function waitForSettlementWindow(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  rail: PreparedRail
): Promise<{ earliestSettlementEpoch: bigint; readyEpoch: bigint }> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const service = await view.dealService(accepted.dealId);
  const currentRail = await view.rail(rail.railId);
  const earliestSettlementEpoch = currentRail.settledUpTo + service.minSettlementEpochs;
  let currentEpoch = evm.blockNumber();

  console.log("=== Wait for V2 settlement window ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Rail: ${rail.railId}`);
  console.log(`  Rail settled up to: ${currentRail.settledUpTo}`);
  console.log(`  Min settlement epochs: ${service.minSettlementEpochs}`);
  console.log(`  Earliest settlement epoch: ${earliestSettlementEpoch}`);
  console.log(`  Current epoch: ${currentEpoch}`);

  if (currentEpoch < earliestSettlementEpoch) {
    await evm.waitForBlock(earliestSettlementEpoch);
    currentEpoch = evm.blockNumber();
  }

  context.state.set("EARLIEST_SETTLEMENT_EPOCH", earliestSettlementEpoch);
  context.state.set("SETTLEMENT_READY_EPOCH", currentEpoch);
  console.log(`  Ready epoch: ${currentEpoch}`);
  console.log("=== V2 settlement window ready ===");
  return { earliestSettlementEpoch, readyEpoch: currentEpoch };
}

export async function refreshEvidenceStatusAndAssertActive(
  context: ScenarioContext,
  active: ActiveDeal
): Promise<{ txHash: string; status: EvidenceStatus }> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const batchSize = envBigInt(context, "V2_EVIDENCE_REFRESH_BATCH_SIZE", BigInt(context.state.get("CLAIM_COUNT") ?? "100"));
  if (batchSize <= 0n) throw new Error(`evidence refresh batch size must be > 0, got ${batchSize}`);
  const evidenceData = evm.abiEncode("f(uint256)", batchSize);

  console.log("=== Refresh V2 evidence status ===");
  console.log(`  Deal: ${active.dealId}`);
  console.log(`  Batch size: ${batchSize}`);
  console.log(`  Committed bytes: ${active.committedBytes}`);

  const txHash = await evm.sendWithPrivateKey(
    context.config.identityKeys.porepService,
    context.config.addresses.poRepMarket,
    "refreshEvidenceStatus(uint256,bytes)",
    [active.dealId, evidenceData],
  );
  const status = await view.evidenceStatus(active.dealId);
  assertEqual(status.activeCoveredBytes, active.committedBytes, "activeCoveredBytes");
  assertEqual(status.result, 40n, "evidence result ACTIVE");
  assertEqual(status.checkedClaims, status.totalClaims, "evidence checked claims");
  if (status.lastEvidenceRefreshEpoch <= 0n) {
    throw new Error(`last evidence refresh epoch expected > 0, got ${status.lastEvidenceRefreshEpoch}`);
  }

  context.state.set("EVIDENCE_REFRESH_TX", txHash);
  context.state.set("EVIDENCE_ACTIVE_COVERED_BYTES", status.activeCoveredBytes);
  context.state.set("EVIDENCE_LAST_REFRESH_EPOCH", status.lastEvidenceRefreshEpoch);
  context.state.set("EVIDENCE_REASON_CODE", status.reasonCode);
  context.state.set("EVIDENCE_RESULT", status.result);
  context.state.set("EVIDENCE_CHECKED_CLAIMS", status.checkedClaims);
  context.state.set("EVIDENCE_TOTAL_CLAIMS", status.totalClaims);
  console.log(`  TX: ${txHash}`);
  console.log(`  Active covered bytes: ${status.activeCoveredBytes}`);
  console.log(`  Last refresh epoch: ${status.lastEvidenceRefreshEpoch}`);
  console.log("  Result: ACTIVE");
  console.log(`  Checked claims: ${status.checkedClaims} / ${status.totalClaims}`);
  console.log("=== V2 evidence status refreshed ===");
  return { txHash, status };
}

export async function refreshEvidenceStatusAndAssertPartial(
  context: ScenarioContext,
  active: ActiveDeal,
  batchSize = 1n
): Promise<{ txHash: string; status: EvidenceStatus }> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const evidenceData = evm.abiEncode("f(uint256)", batchSize);

  console.log("=== Refresh V2 evidence status and expect PARTIAL ===");
  console.log(`  Deal: ${active.dealId}`);
  console.log(`  Batch size: ${batchSize}`);
  console.log(`  Committed bytes: ${active.committedBytes}`);

  const txHash = await evm.sendWithPrivateKey(
    context.config.identityKeys.porepService,
    context.config.addresses.poRepMarket,
    "refreshEvidenceStatus(uint256,bytes)",
    [active.dealId, evidenceData],
  );
  const status = await view.evidenceStatus(active.dealId);
  assertEqual(status.result, 10n, "evidence result PARTIAL");
  if (status.checkedClaims <= 0n || status.checkedClaims >= status.totalClaims) {
    throw new Error(`partial evidence refresh expected checkedClaims between 0 and total, got ${status.checkedClaims}/${status.totalClaims}`);
  }
  if (status.activeCoveredBytes <= 0n || status.activeCoveredBytes >= active.committedBytes) {
    throw new Error(`partial activeCoveredBytes expected between 0 and committed bytes, got ${status.activeCoveredBytes}/${active.committedBytes}`);
  }

  context.state.set("PARTIAL_EVIDENCE_REFRESH_TX", txHash);
  context.state.set("PARTIAL_EVIDENCE_ACTIVE_COVERED_BYTES", status.activeCoveredBytes);
  context.state.set("PARTIAL_EVIDENCE_RESULT", status.result);
  context.state.set("PARTIAL_EVIDENCE_CHECKED_CLAIMS", status.checkedClaims);
  context.state.set("PARTIAL_EVIDENCE_TOTAL_CLAIMS", status.totalClaims);
  console.log(`  TX: ${txHash}`);
  console.log(`  Result: PARTIAL`);
  console.log(`  Active covered bytes: ${status.activeCoveredBytes}`);
  console.log(`  Checked claims: ${status.checkedClaims} / ${status.totalClaims}`);
  console.log("=== V2 evidence status partially refreshed ===");
  return { txHash, status };
}

export async function refreshEvidenceStatusWithBatchAndAssertActive(
  context: ScenarioContext,
  active: ActiveDeal,
  batchSize = 1n
): Promise<{ txHash: string; status: EvidenceStatus }> {
  const previous = context.config.env.V2_EVIDENCE_REFRESH_BATCH_SIZE;
  context.config.env.V2_EVIDENCE_REFRESH_BATCH_SIZE = batchSize.toString();
  try {
    return await refreshEvidenceStatusAndAssertActive(context, active);
  } finally {
    if (previous === undefined) {
      delete context.config.env.V2_EVIDENCE_REFRESH_BATCH_SIZE;
    } else {
      context.config.env.V2_EVIDENCE_REFRESH_BATCH_SIZE = previous;
    }
  }
}

export async function settleRailAndAssertProviderPayout(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  active: ActiveDeal,
  rail: PreparedRail
): Promise<{ txHash: string; paidAmount: bigint; targetEpoch: bigint }> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const service = await view.dealService(accepted.dealId);
  const currentRail = await view.rail(rail.railId);
  const status = await view.evidenceStatus(accepted.dealId);
  const refreshGrace = await view.evidenceRefreshGraceEpochs();
  const currentEpoch = evm.blockNumber();
  const earliestSettlement = currentRail.settledUpTo + service.minSettlementEpochs;
  const maxFreshTarget = status.lastEvidenceRefreshEpoch + refreshGrace;
  const targetEpoch = currentEpoch > maxFreshTarget ? maxFreshTarget : currentEpoch;

  console.log("=== Settle V2 rail ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Rail: ${rail.railId}`);
  console.log(`  Service epochs: ${service.startEpoch} -> ${service.endEpoch}`);
  console.log(`  Last deal-settled epoch: ${service.lastSettledEpoch}`);
  console.log(`  Rail settled up to: ${currentRail.settledUpTo}`);
  console.log(`  Min settlement epochs: ${service.minSettlementEpochs}`);
  console.log(`  Earliest settlement epoch: ${earliestSettlement}`);
  console.log(`  Current epoch: ${currentEpoch}`);
  console.log(`  Target epoch: ${targetEpoch}`);
  console.log(`  Evidence last refresh epoch: ${status.lastEvidenceRefreshEpoch}`);
  console.log(`  Evidence freshness grace: ${refreshGrace}`);
  console.log(`  Committed bytes: ${active.committedBytes}`);
  console.log(`  Active evidence bytes: ${status.activeCoveredBytes}`);
  console.log(`  Evidence result: ${status.result}`);
  console.log(`  Checked claims: ${status.checkedClaims} / ${status.totalClaims}`);
  console.log(`  Rail payment rate: ${active.paymentRate}`);

  assertEqual(status.activeCoveredBytes, active.committedBytes, "settlement activeCoveredBytes");
  assertEqual(status.result, 40n, "settlement evidence result ACTIVE");
  assertEqual(status.checkedClaims, status.totalClaims, "settlement checked claims");
  if (targetEpoch < earliestSettlement) {
    throw new Error(`settlement blocked: target epoch ${targetEpoch} is before earliest settlement epoch ${earliestSettlement}`);
  }
  if (status.lastEvidenceRefreshEpoch <= 0n || targetEpoch > maxFreshTarget) {
    throw new Error(`settlement blocked: evidence refresh is too old for target epoch ${targetEpoch}`);
  }

  const before = await view.accountFunds(currentRail.to);
  const txHash = await evm.send(context.config.addresses.filecoinPay, "settleRail(uint256,uint256)", [rail.railId, targetEpoch]);
  const after = await view.accountFunds(currentRail.to);
  const paidAmount = after - before;
  if (paidAmount <= 0n) throw new Error(`settlement paid amount expected > 0, got ${paidAmount}`);

  context.state.set("SETTLEMENT_TX", txHash);
  context.state.set("PAID_AMOUNT", paidAmount);
  context.state.set("SETTLED_TARGET_EPOCH", targetEpoch);
  console.log(`  TX: ${txHash}`);
  console.log(`  Paid amount: ${paidAmount}`);
  console.log("=== V2 rail settled ===");
  return { txHash, paidAmount, targetEpoch };
}

export async function expectSettlementBlockedWithoutPayout(
  context: ScenarioContext,
  dealId: bigint,
  rail: PreparedRail,
  targetEpoch: bigint,
  expectedError: "NoAttestation" | "NoProgressInSettlement"
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const beforeRail = await view.rail(rail.railId);
  const beforeFunds = await view.accountFunds(beforeRail.to);

  console.log("=== Expect V2 settlement to be blocked ===");
  console.log(`  Rail: ${rail.railId}`);
  console.log(`  Target epoch: ${targetEpoch}`);
  console.log(`  Expected error: ${expectedError}`);
  console.log(`  Payee before: ${beforeFunds}`);
  console.log(`  Rail settled up to before: ${beforeRail.settledUpTo}`);

  const abi = expectedError === "NoAttestation" ? artifactAbis(context).sliScorer : artifactAbis(context).filecoinPay;
  const error = await expectCustomError(
    () => evm.simulate(context.config.addresses.filecoinPay, "settleRail(uint256,uint256)", [rail.railId, targetEpoch]),
    abi,
    expectedError
  );
  if (expectedError === "NoAttestation") {
    assertEqual(error.args[0], dealId, "NoAttestation dealId");
  } else {
    assertEqual(error.args[0], rail.railId, "NoProgressInSettlement railId");
    assertEqual(error.args[2], beforeRail.settledUpTo, "NoProgressInSettlement actual settled epoch");
  }
  console.log(`  Settlement failed with ${error.name}`);

  const afterRail = await view.rail(rail.railId);
  const afterFunds = await view.accountFunds(afterRail.to);
  assertEqual(afterFunds, beforeFunds, `payee funds unchanged after ${expectedError}`);
  assertEqual(afterRail.settledUpTo, beforeRail.settledUpTo, `rail settledUpTo unchanged after ${expectedError}`);
  console.log("Expected settlement block observed without payout");
}

export async function settleRailAgainAtSameTargetAndAssertNoPayout(
  context: ScenarioContext,
  rail: PreparedRail,
  targetEpoch: bigint
): Promise<{ txHash: string; paidAmount: bigint }> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const beforeRail = await view.rail(rail.railId);
  const beforeFunds = await view.accountFunds(beforeRail.to);

  console.log("=== Repeat V2 rail settlement at same target ===");
  console.log(`  Rail: ${rail.railId}`);
  console.log(`  Target epoch: ${targetEpoch}`);
  console.log(`  Payee before: ${beforeFunds}`);
  console.log(`  Rail settled up to before: ${beforeRail.settledUpTo}`);

  const txHash = await evm.send(context.config.addresses.filecoinPay, "settleRail(uint256,uint256)", [rail.railId, targetEpoch]);
  const afterRail = await view.rail(rail.railId);
  const afterFunds = await view.accountFunds(afterRail.to);
  const paidAmount = afterFunds - beforeFunds;
  assertEqual(paidAmount, 0n, "repeated settlement paid amount");
  assertEqual(afterRail.settledUpTo, beforeRail.settledUpTo, "repeated settlement settledUpTo");

  context.state.set("REPEATED_SETTLEMENT_TX", txHash);
  context.state.set("REPEATED_SETTLEMENT_PAID_AMOUNT", paidAmount);
  console.log(`  TX: ${txHash}`);
  console.log(`  Paid amount: ${paidAmount}`);
  console.log("=== Repeated V2 rail settlement paid no additional amount ===");
  return { txHash, paidAmount };
}

export async function settleRailAndAssertOnlySelectedRailAdvanced(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  active: ActiveDeal,
  rail: PreparedRail,
  otherRail: PreparedRail
): Promise<{ txHash: string; paidAmount: bigint; targetEpoch: bigint; payerBefore: Account; payerAfter: Account; settlement: RailSettledEvent }> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const service = await view.dealService(accepted.dealId);
  const beforeRail = await view.rail(rail.railId);
  const beforeOtherRail = await view.rail(otherRail.railId);
  const status = await view.evidenceStatus(accepted.dealId);
  const refreshGrace = await view.evidenceRefreshGraceEpochs();
  const currentEpoch = evm.blockNumber();
  const earliestSettlement = beforeRail.settledUpTo + service.minSettlementEpochs;
  const maxFreshTarget = status.lastEvidenceRefreshEpoch + refreshGrace;
  const targetEpoch = currentEpoch > maxFreshTarget ? maxFreshTarget : currentEpoch;
  const payerBefore = await view.account(beforeRail.from);
  const payeeBefore = await view.account(beforeRail.to);
  const otherPayeeBefore = await view.account(beforeOtherRail.to);

  console.log("=== Settle selected V2 rail and assert shared-account isolation ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Rail: ${rail.railId}`);
  console.log(`  Other rail: ${otherRail.railId}`);
  console.log(`  Payer account before: funds=${payerBefore.funds}, lockupCurrent=${payerBefore.lockupCurrent}, lockupRate=${payerBefore.lockupRate}, lockupLastSettledAt=${payerBefore.lockupLastSettledAt}`);
  console.log(`  Target epoch: ${targetEpoch}`);

  assertEqual(status.activeCoveredBytes, active.committedBytes, "settlement activeCoveredBytes");
  assertEqual(status.result, 40n, "settlement evidence result ACTIVE");
  assertEqual(status.checkedClaims, status.totalClaims, "settlement checked claims");
  if (targetEpoch < earliestSettlement) {
    throw new Error(`settlement blocked: target epoch ${targetEpoch} is before earliest settlement epoch ${earliestSettlement}`);
  }

  const txHash = await evm.send(context.config.addresses.filecoinPay, "settleRail(uint256,uint256)", [rail.railId, targetEpoch]);
  const settlement = railSettledEventFromReceipt(context, evm.receipt(txHash), rail.railId);
  const afterRail = await view.rail(rail.railId);
  const afterOtherRail = await view.rail(otherRail.railId);
  const payerAfter = await view.account(beforeRail.from);
  const payeeAfter = await view.account(beforeRail.to);
  const otherPayeeAfter = await view.account(beforeOtherRail.to);
  const paidAmount = settlement.totalNetPayeeAmount;
  const payerFundsDelta = payerBefore.funds - payerAfter.funds;
  const payeeFundsDelta = payeeAfter.funds - payeeBefore.funds;

  if (paidAmount <= 0n) throw new Error(`settlement paid amount expected > 0, got ${paidAmount}`);
  assertEqual(afterRail.settledUpTo, targetEpoch, "selected rail settledUpTo");
  assertEqual(settlement.settledUpTo, afterRail.settledUpTo, "RailSettled settledUpTo");
  assertEqual(afterOtherRail.settledUpTo, beforeOtherRail.settledUpTo, "other rail settledUpTo while selected rail settled");
  assertEqual(otherPayeeAfter.funds, otherPayeeBefore.funds, "other payee funds while selected rail settled");
  assertSettlementAccountingMatchesEvent({
    payerFundsDelta,
    payeeFundsDelta,
    totalSettledAmount: settlement.totalSettledAmount,
    totalNetPayeeAmount: settlement.totalNetPayeeAmount,
    operatorCommission: settlement.operatorCommission,
    networkFee: settlement.networkFee
  });
  assertEqual(payerAfter.lockupRate, payerBefore.lockupRate, "payer lockup rate after selected rail settlement");
  if (payerAfter.lockupLastSettledAt < payerBefore.lockupLastSettledAt) {
    throw new Error(`payer lockupLastSettledAt decreased from ${payerBefore.lockupLastSettledAt} to ${payerAfter.lockupLastSettledAt}`);
  }
  if (payerAfter.funds < payerAfter.lockupCurrent) {
    throw new Error(`payer account underfunded after settlement: funds=${payerAfter.funds}, lockupCurrent=${payerAfter.lockupCurrent}`);
  }

  context.state.set(`SETTLEMENT_TX_RAIL_${rail.railId}`, txHash);
  context.state.set(`PAID_AMOUNT_RAIL_${rail.railId}`, paidAmount);
  context.state.set(`GROSS_SETTLED_AMOUNT_RAIL_${rail.railId}`, settlement.totalSettledAmount);
  context.state.set(`NETWORK_FEE_RAIL_${rail.railId}`, settlement.networkFee);
  context.state.set(`OPERATOR_COMMISSION_RAIL_${rail.railId}`, settlement.operatorCommission);
  context.state.set(`SETTLED_TARGET_EPOCH_RAIL_${rail.railId}`, targetEpoch);
  context.state.set(`PAYER_FUNDS_AFTER_RAIL_${rail.railId}`, payerAfter.funds);
  context.state.set(`PAYER_LOCKUP_CURRENT_AFTER_RAIL_${rail.railId}`, payerAfter.lockupCurrent);
  context.state.set(`PAYER_LOCKUP_RATE_AFTER_RAIL_${rail.railId}`, payerAfter.lockupRate);
  context.state.set(`PAYER_LOCKUP_LAST_SETTLED_AFTER_RAIL_${rail.railId}`, payerAfter.lockupLastSettledAt);
  console.log(`  TX: ${txHash}`);
  console.log(`  Gross settled amount: ${settlement.totalSettledAmount}`);
  console.log(`  Net payee amount: ${paidAmount}`);
  console.log(`  Network fee: ${settlement.networkFee}`);
  console.log(`  Operator commission: ${settlement.operatorCommission}`);
  console.log(`  Payer account after: funds=${payerAfter.funds}, lockupCurrent=${payerAfter.lockupCurrent}, lockupRate=${payerAfter.lockupRate}, lockupLastSettledAt=${payerAfter.lockupLastSettledAt}`);
  console.log("=== Selected V2 rail settled without advancing the other rail ===");
  return { txHash, paidAmount, targetEpoch, payerBefore, payerAfter, settlement };
}

export async function assertSharedPayerAccountCoversBothRails(
  context: ScenarioContext,
  firstRail: PreparedRail,
  secondRail: PreparedRail,
  baseline?: Account
): Promise<Account> {
  requireDevnet(context);
  const view = contracts(context);
  const first = await view.rail(firstRail.railId);
  const second = await view.rail(secondRail.railId);
  assertEqual(first.from, second.from, "shared payer account");
  const account = await view.account(first.from);
  const expectedRate = expectedSharedPayerLockupRate(baseline?.lockupRate ?? 0n, first.paymentRate, second.paymentRate);
  assertEqual(account.lockupRate, expectedRate, "shared payer lockupRate");
  if (account.funds < account.lockupCurrent) {
    throw new Error(`shared payer account underfunded: funds=${account.funds}, lockupCurrent=${account.lockupCurrent}`);
  }
  context.state.set("SHARED_PAYER", first.from);
  if (baseline) {
    context.state.set("SHARED_PAYER_BASELINE_LOCKUP_RATE", baseline.lockupRate);
    context.state.set("SHARED_PAYER_BASELINE_LOCKUP_CURRENT", baseline.lockupCurrent);
  }
  context.state.set("SHARED_PAYER_FUNDS", account.funds);
  context.state.set("SHARED_PAYER_LOCKUP_CURRENT", account.lockupCurrent);
  context.state.set("SHARED_PAYER_LOCKUP_RATE", account.lockupRate);
  context.state.set("SHARED_PAYER_LOCKUP_LAST_SETTLED_AT", account.lockupLastSettledAt);
  console.log("=== Shared V2 payer account snapshot ===");
  console.log(`  Payer: ${first.from}`);
  if (baseline) console.log(`  Baseline lockup rate: ${baseline.lockupRate}`);
  console.log(`  Funds: ${account.funds}`);
  console.log(`  Lockup current: ${account.lockupCurrent}`);
  console.log(`  Lockup rate: ${account.lockupRate}`);
  console.log(`  Lockup last settled at: ${account.lockupLastSettledAt}`);
  return account;
}

export function expectedSharedPayerLockupRate(
  baselineLockupRate: bigint,
  firstRailPaymentRate: bigint,
  secondRailPaymentRate: bigint
): bigint {
  return baselineLockupRate + firstRailPaymentRate + secondRailPaymentRate;
}

export function assertSettlementAccountingMatchesEvent(accounting: SettlementAccounting): void {
  assertEqual(accounting.payerFundsDelta, accounting.totalSettledAmount, "payer gross funds delta for selected rail settlement");
  assertEqual(accounting.payeeFundsDelta, accounting.totalNetPayeeAmount, "payee net funds delta for selected rail settlement");
  assertEqual(
    accounting.totalSettledAmount,
    accounting.totalNetPayeeAmount + accounting.operatorCommission + accounting.networkFee,
    "settlement gross amount equals net payee amount plus fees"
  );
}

function railSettledEventFromReceipt(context: ScenarioContext, receipt: TxReceipt, expectedRailId: bigint): RailSettledEvent {
  const evm = new Evm(context);
  const event = evm.parseEvent(receipt, artifactAbis(context).filecoinPay, "RailSettled");
  const settled = {
    railId: firstUint(event.args[0]),
    totalSettledAmount: firstUint(event.args[1]),
    totalNetPayeeAmount: firstUint(event.args[2]),
    operatorCommission: firstUint(event.args[3]),
    networkFee: firstUint(event.args[4]),
    settledUpTo: firstUint(event.args[5])
  };
  assertEqual(settled.railId, expectedRailId, "RailSettled railId");
  return settled;
}
