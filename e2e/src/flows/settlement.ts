import { assertEqual } from "../assertions.js";
import {
  billed32GiBUnits,
  EVIDENCE_REFRESH_GRACE_EPOCHS,
  netPayeeAmount,
  networkFee,
  settlementAmount,
} from "../expected.js";
import type { ScenarioContext } from "../runtime.js";
import { envBigInt } from "../runtime.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm, firstUint, type TxReceipt } from "../contracts/evm.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
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

export type ExactSettlementAccounting = SettlementAccounting & {
  expectedGross: bigint;
  expectedNetworkFee: bigint;
  expectedNetPayee: bigint;
};

export type SettlementOutcomeExpectation = {
  settlementAmount: bigint;
  settleUpto: bigint;
  note: string;
};

export function settleAccountLockupAtEpoch(account: Account, currentEpoch: bigint): Account {
  if (currentEpoch < account.lockupLastSettledAt) {
    throw new Error(`lockup settlement epoch ${currentEpoch} is before ${account.lockupLastSettledAt}`);
  }
  if (account.lockupRate === 0n) {
    return { ...account, lockupLastSettledAt: currentEpoch };
  }
  const elapsed = currentEpoch - account.lockupLastSettledAt;
  const availableFunds = account.funds - account.lockupCurrent;
  if (availableFunds < 0n) {
    throw new Error(`lockup current ${account.lockupCurrent} exceeds funds ${account.funds}`);
  }
  const fundedEpochs = availableFunds / account.lockupRate;
  const settledEpochs = elapsed < fundedEpochs ? elapsed : fundedEpochs;
  return {
    ...account,
    lockupCurrent: account.lockupCurrent + (account.lockupRate * settledEpochs),
    lockupLastSettledAt: account.lockupLastSettledAt + settledEpochs,
  };
}

type ExactSettlement = {
  txHash: string;
  paidAmount: bigint;
  targetEpoch: bigint;
  fromEpoch: bigint;
  expectedGross: bigint;
  payerBefore: Account;
  payerAfter: Account;
  settlement: RailSettledEvent;
};

export async function setSliAttestationForDeal(
  context: ScenarioContext,
  accepted: Pick<AcceptedDeal, "dealId">
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
  accepted: Pick<AcceptedDeal, "dealId">
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

  await evm.ensureEvmActor(context.config.privateKeySp);
  const txHash = await evm.sendWithPrivateKey(
    context.config.privateKeySp,
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

  const previous = await view.evidenceStatus(active.dealId);
  const preview = evidenceStatusFromResult(await evm.contract(
    context.config.addresses.poRepMarket,
    artifactAbis(context).poRepMarket,
  ).refreshEvidenceStatus.staticCall(active.dealId, evidenceData, {
    from: context.config.identityAddresses.porepService,
  }));
  assertEqual(preview.result, 10n, "partial refresh static result PARTIAL");
  assertEqual(preview.checkedClaims, batchSize, "partial refresh static checked claims");
  assertEqual(preview.totalClaims, 2n, "partial refresh static total claims");
  assertEqual(active.committedBytes % 2n, 0n, "multi-claim committed bytes divide evenly");
  assertEqual(preview.activeCoveredBytes, active.committedBytes / 2n, "partial refresh static active covered bytes");

  const txHash = await evm.sendWithPrivateKey(
    context.config.identityKeys.porepService,
    context.config.addresses.poRepMarket,
    "refreshEvidenceStatus(uint256,bytes)",
    [active.dealId, evidenceData],
  );
  const status = await view.evidenceStatus(active.dealId);
  assertPartialEvidenceRefreshPersistence(previous, preview, status, active.committedBytes, batchSize);

  context.state.set("PARTIAL_EVIDENCE_REFRESH_TX", txHash);
  context.state.set("PARTIAL_EVIDENCE_ACTIVE_COVERED_BYTES", status.activeCoveredBytes);
  context.state.set("PARTIAL_EVIDENCE_RESULT", status.result);
  context.state.set("PARTIAL_EVIDENCE_CHECKED_CLAIMS", status.checkedClaims);
  context.state.set("PARTIAL_EVIDENCE_TOTAL_CLAIMS", status.totalClaims);
  console.log(`  TX: ${txHash}`);
  console.log(`  Static result: PARTIAL`);
  console.log(`  Persisted result: ${status.result}`);
  console.log(`  Active covered bytes: ${status.activeCoveredBytes}`);
  console.log(`  Checked claims: ${status.checkedClaims} / ${status.totalClaims}`);
  console.log("=== V2 evidence status partially refreshed ===");
  return { txHash, status };
}

export function assertPartialEvidenceRefreshPersistence(
  previous: EvidenceStatus,
  preview: EvidenceStatus,
  persisted: EvidenceStatus,
  committedBytes: bigint,
  batchSize: bigint,
): void {
  assertEqual(preview.result, 10n, "partial refresh preview result");
  assertEqual(preview.checkedClaims, batchSize, "partial refresh preview checked claims");
  assertEqual(preview.totalClaims, 2n, "partial refresh preview total claims");
  assertEqual(committedBytes % 2n, 0n, "partial refresh committed bytes divide evenly");
  assertEqual(preview.activeCoveredBytes, committedBytes / 2n, "partial refresh preview active covered bytes");
  assertEqual(persisted.result, previous.result, "partial refresh persisted prior completed result");
  assertEqual(persisted.lastEvidenceRefreshEpoch, previous.lastEvidenceRefreshEpoch, "partial refresh persisted prior completed epoch");
  assertEqual(persisted.activeCoveredBytes, previous.activeCoveredBytes, "partial refresh persisted prior completed active covered bytes");
  assertEqual(persisted.checkedClaims, preview.checkedClaims, "partial refresh persisted checked claims");
  assertEqual(persisted.totalClaims, preview.totalClaims, "partial refresh persisted total claims");
}

function evidenceStatusFromResult(value: unknown): EvidenceStatus {
  const result = value as { [index: number]: unknown };
  return {
    activeCoveredBytes: firstUint(result[0]),
    lastEvidenceRefreshEpoch: firstUint(result[1]),
    reasonCode: firstUint(result[2]),
    result: firstUint(result[3]),
    checkedClaims: firstUint(result[4]),
    totalClaims: firstUint(result[5]),
  };
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
): Promise<{ txHash: string; paidAmount: bigint; targetEpoch: bigint; fromEpoch: bigint; expectedGross: bigint }> {
  const result = await settleRailAndAssertExact(context, accepted, active, rail);

  context.state.set("SETTLEMENT_TX", result.txHash);
  context.state.set("PAID_AMOUNT", result.paidAmount);
  context.state.set("SETTLED_TARGET_EPOCH", result.targetEpoch);
  return result;
}

export async function settleRailAtEpochAndAssertOutcome(
  context: ScenarioContext,
  accepted: Pick<AcceptedDeal, "dealId">,
  rail: Pick<PreparedRail, "railId">,
  targetEpoch: bigint,
  expectedOutcome: SettlementOutcomeExpectation,
  expectedMarketLastSettledEpoch: bigint,
): Promise<{ txHash: string; paidAmount: bigint; fromEpoch: bigint }> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const beforeRail = await view.rail(rail.railId);
  assertEqual(beforeRail.commissionRateBps, 0n, "validator rail commission rate bps");

  const expectedNetworkFee = networkFee(expectedOutcome.settlementAmount);
  const expectedNetPayee = netPayeeAmount(expectedOutcome.settlementAmount);
  await assertSimulatedSettlementOutcome(context, evm, rail.railId, targetEpoch, expectedOutcome);
  const payerBefore = await view.account(beforeRail.from);
  const payeeBefore = await view.account(beforeRail.to);
  const txHash = await evm.send(context.config.addresses.filecoinPay, "settleRail(uint256,uint256)", [rail.railId, targetEpoch]);
  const settlement = railSettledEventFromReceipt(context, evm.receipt(txHash), rail.railId);
  const afterRail = await view.rail(rail.railId);
  const serviceAfter = await view.dealService(accepted.dealId);
  const payerAfter = await view.account(beforeRail.from);
  const payeeAfter = await view.account(beforeRail.to);
  assertEqual(afterRail.settledUpTo, expectedOutcome.settleUpto, "terminal rail settledUpTo");
  assertEqual(settlement.settledUpTo, expectedOutcome.settleUpto, "terminal RailSettled settledUpTo");
  assertEqual(serviceAfter.lastSettledEpoch, expectedMarketLastSettledEpoch, "terminal deal lastSettledEpoch");
  assertExactSettlementAccounting({
    payerFundsDelta: payerBefore.funds - payerAfter.funds,
    payeeFundsDelta: payeeAfter.funds - payeeBefore.funds,
    totalSettledAmount: settlement.totalSettledAmount,
    totalNetPayeeAmount: settlement.totalNetPayeeAmount,
    operatorCommission: settlement.operatorCommission,
    networkFee: settlement.networkFee,
    expectedGross: expectedOutcome.settlementAmount,
    expectedNetworkFee,
    expectedNetPayee,
  });
  return { txHash, paidAmount: expectedNetPayee, fromEpoch: beforeRail.settledUpTo };
}

async function settleRailAndAssertExact(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  active: ActiveDeal,
  rail: PreparedRail
): Promise<ExactSettlement> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const service = await view.dealService(accepted.dealId);
  const payment = await view.dealPayment(accepted.dealId);
  const beforeRail = await view.rail(rail.railId);
  const status = await view.evidenceStatus(accepted.dealId);
  const currentEpoch = evm.blockNumber();
  const earliestSettlement = beforeRail.settledUpTo + service.minSettlementEpochs;
  const maxFreshTarget = status.lastEvidenceRefreshEpoch + EVIDENCE_REFRESH_GRACE_EPOCHS;
  const targetEpoch = currentEpoch > maxFreshTarget ? maxFreshTarget : currentEpoch;
  const expectedGross = settlementAmount(
    payment.pricePer32GiBPerMonth,
    billed32GiBUnits(active.committedBytes),
    service.startEpoch,
    beforeRail.settledUpTo,
    targetEpoch,
  );
  const expectedNetworkFee = networkFee(expectedGross);
  const expectedNetPayee = netPayeeAmount(expectedGross);
  const payerBefore = await view.account(beforeRail.from);
  const payeeBefore = await view.account(beforeRail.to);

  console.log("=== Settle V2 rail with exact accounting ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Rail: ${rail.railId}`);
  console.log(`  Target epoch: ${targetEpoch}`);
  console.log(`  Expected gross/net/fee: ${expectedGross}/${expectedNetPayee}/${expectedNetworkFee}`);
  assertEqual(status.activeCoveredBytes, active.committedBytes, "settlement activeCoveredBytes");
  assertEqual(status.result, 40n, "settlement evidence result ACTIVE");
  assertEqual(status.checkedClaims, status.totalClaims, "settlement checked claims");
  assertEqual(beforeRail.commissionRateBps, 0n, "validator rail commission rate bps");
  if (targetEpoch < earliestSettlement) {
    throw new Error(`settlement blocked: target epoch ${targetEpoch} is before earliest settlement epoch ${earliestSettlement}`);
  }
  if (status.lastEvidenceRefreshEpoch <= 0n || targetEpoch > maxFreshTarget) {
    throw new Error(`settlement blocked: evidence refresh is too old for target epoch ${targetEpoch}`);
  }

  await assertSimulatedSettlementOutcome(context, evm, rail.railId, targetEpoch, {
    settlementAmount: expectedGross,
    settleUpto: targetEpoch,
    note: "payment validated successfully",
  });
  const txHash = await evm.send(context.config.addresses.filecoinPay, "settleRail(uint256,uint256)", [rail.railId, targetEpoch]);
  const settlement = railSettledEventFromReceipt(context, evm.receipt(txHash), rail.railId);
  const afterRail = await view.rail(rail.railId);
  const serviceAfter = await view.dealService(accepted.dealId);
  const payerAfter = await view.account(beforeRail.from);
  const payeeAfter = await view.account(beforeRail.to);
  assertEqual(afterRail.settledUpTo, targetEpoch, "rail settledUpTo");
  assertEqual(settlement.settledUpTo, targetEpoch, "RailSettled settledUpTo");
  assertEqual(serviceAfter.lastSettledEpoch, targetEpoch, "deal lastSettledEpoch");
  assertExactSettlementAccounting({
    payerFundsDelta: payerBefore.funds - payerAfter.funds,
    payeeFundsDelta: payeeAfter.funds - payeeBefore.funds,
    totalSettledAmount: settlement.totalSettledAmount,
    totalNetPayeeAmount: settlement.totalNetPayeeAmount,
    operatorCommission: settlement.operatorCommission,
    networkFee: settlement.networkFee,
    expectedGross,
    expectedNetworkFee,
    expectedNetPayee,
  });
  return {
    txHash,
    paidAmount: expectedNetPayee,
    targetEpoch,
    fromEpoch: beforeRail.settledUpTo,
    expectedGross,
    payerBefore,
    payerAfter,
    settlement,
  };
}

async function assertSimulatedSettlementOutcome(
  context: ScenarioContext,
  evm: Evm,
  railId: bigint,
  targetEpoch: bigint,
  expected: SettlementOutcomeExpectation,
): Promise<void> {
  const expectedNetworkFee = networkFee(expected.settlementAmount);
  const expectedNetPayee = netPayeeAmount(expected.settlementAmount);
  const simulated = await evm.contract(
    context.config.addresses.filecoinPay,
    artifactAbis(context).filecoinPay,
  ).settleRail.staticCall(railId, targetEpoch, { from: evm.signerAddress }) as unknown[];
  assertEqual(firstUint(simulated[0]), expected.settlementAmount, "simulated settlement gross amount");
  assertEqual(firstUint(simulated[1]), expectedNetPayee, "simulated settlement net payee amount");
  assertEqual(firstUint(simulated[2]), 0n, "simulated settlement operator commission");
  assertEqual(firstUint(simulated[3]), expectedNetworkFee, "simulated settlement network fee");
  assertEqual(firstUint(simulated[4]), expected.settleUpto, "simulated settlement final cursor");
  assertEqual(String(simulated[5]), expected.note, "simulated settlement note");
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
  const error = await expectRevertOnSend(
    evm,
    context.config.privateKeyTest,
    context.config.addresses.filecoinPay,
    "settleRail(uint256,uint256)",
    [rail.railId, targetEpoch],
    abi,
    expectedError
  );
  if (expectedError === "NoAttestation") {
    assertEqual(error.args[0], dealId, "NoAttestation dealId");
  } else {
    assertEqual(error.args[0], rail.railId, "NoProgressInSettlement railId");
    assertEqual(error.args[1], beforeRail.settledUpTo + 1n, "NoProgressInSettlement expected settled epoch");
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
  const view = contracts(context);
  const beforeOtherRail = await view.rail(otherRail.railId);
  const otherPayeeBefore = await view.account(beforeOtherRail.to);

  console.log("=== Settle selected V2 rail and assert shared-account isolation ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Rail: ${rail.railId}`);
  console.log(`  Other rail: ${otherRail.railId}`);
  const result = await settleRailAndAssertExact(context, accepted, active, rail);
  const afterRail = await view.rail(rail.railId);
  const afterOtherRail = await view.rail(otherRail.railId);
  const otherPayeeAfter = await view.account(beforeOtherRail.to);
  assertEqual(afterRail.settledUpTo, result.targetEpoch, "selected rail settledUpTo");
  assertEqual(result.settlement.settledUpTo, afterRail.settledUpTo, "RailSettled settledUpTo");
  assertEqual(afterOtherRail.settledUpTo, beforeOtherRail.settledUpTo, "other rail settledUpTo while selected rail settled");
  assertEqual(otherPayeeAfter.funds, otherPayeeBefore.funds, "other payee funds while selected rail settled");
  assertEqual(result.payerAfter.lockupRate, result.payerBefore.lockupRate, "payer lockup rate after selected rail settlement");
  if (result.payerAfter.lockupLastSettledAt < result.payerBefore.lockupLastSettledAt) {
    throw new Error(`payer lockupLastSettledAt decreased from ${result.payerBefore.lockupLastSettledAt} to ${result.payerAfter.lockupLastSettledAt}`);
  }
  if (result.payerAfter.funds < result.payerAfter.lockupCurrent) {
    throw new Error(`payer account underfunded after settlement: funds=${result.payerAfter.funds}, lockupCurrent=${result.payerAfter.lockupCurrent}`);
  }

  context.state.set(`SETTLEMENT_TX_RAIL_${rail.railId}`, result.txHash);
  context.state.set(`PAID_AMOUNT_RAIL_${rail.railId}`, result.paidAmount);
  context.state.set(`GROSS_SETTLED_AMOUNT_RAIL_${rail.railId}`, result.settlement.totalSettledAmount);
  context.state.set(`NETWORK_FEE_RAIL_${rail.railId}`, result.settlement.networkFee);
  context.state.set(`OPERATOR_COMMISSION_RAIL_${rail.railId}`, result.settlement.operatorCommission);
  context.state.set(`SETTLED_TARGET_EPOCH_RAIL_${rail.railId}`, result.targetEpoch);
  context.state.set(`PAYER_FUNDS_AFTER_RAIL_${rail.railId}`, result.payerAfter.funds);
  context.state.set(`PAYER_LOCKUP_CURRENT_AFTER_RAIL_${rail.railId}`, result.payerAfter.lockupCurrent);
  context.state.set(`PAYER_LOCKUP_RATE_AFTER_RAIL_${rail.railId}`, result.payerAfter.lockupRate);
  context.state.set(`PAYER_LOCKUP_LAST_SETTLED_AFTER_RAIL_${rail.railId}`, result.payerAfter.lockupLastSettledAt);

  console.log("=== Selected V2 rail settled without advancing the other rail ===");
  return result;
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

export function assertExactSettlementAccounting(accounting: ExactSettlementAccounting): void {
  assertEqual(accounting.payerFundsDelta, accounting.expectedGross, "payer gross funds delta");
  assertEqual(accounting.payeeFundsDelta, accounting.expectedNetPayee, "payee net funds delta");
  assertEqual(accounting.totalSettledAmount, accounting.expectedGross, "RailSettled gross amount");
  assertEqual(accounting.totalNetPayeeAmount, accounting.expectedNetPayee, "RailSettled net payee amount");
  assertEqual(accounting.operatorCommission, 0n, "RailSettled operator commission");
  assertEqual(accounting.networkFee, accounting.expectedNetworkFee, "RailSettled network fee");
  assertSettlementAccountingMatchesEvent(accounting);
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
