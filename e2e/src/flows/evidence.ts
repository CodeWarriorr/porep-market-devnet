import { assertEqual } from "../assertions.js";
import type { ScenarioContext } from "../runtime.js";
import { envBigInt } from "../runtime.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm } from "../contracts/evm.js";
import { expectCustomError } from "../contracts/reverts.js";
import { contracts } from "../contracts/views.js";
import { requireDevnet } from "../devnet/docker.js";
import type { AcceptedDeal } from "./deal.js";
import type { PreparedRail } from "./validatorRail.js";

export type SubmittedEvidence = {
  txHash: string;
  claimIds: bigint[];
};

export type ActiveDeal = {
  dealId: bigint;
  committedBytes: bigint;
  paymentRate: bigint;
};

export async function submitEvidenceBatchAndAssertClaimCoverage(
  context: ScenarioContext,
  accepted: AcceptedDeal
): Promise<SubmittedEvidence> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const batchSize = envBigInt(context, "V2_EVIDENCE_BATCH_SIZE", 100n);
  const evidenceData = evm.abiEncode("f(uint256)", batchSize);

  console.log("=== Submit V2 evidence batch ===");
  console.log(`  Deal:       ${accepted.dealId}`);
  console.log(`  Batch size: ${batchSize}`);

  const txHash = await evm.sendWithPrivateKey(
    context.config.identityKeys.porepService,
    context.config.addresses.poRepMarket,
    "submitEvidenceBatch(uint256,bytes)",
    [accepted.dealId, evidenceData],
  );
  const claimIds = await view.claimIds(accepted.dealId);
  if (claimIds.length === 0) throw new Error("no claim ids recorded after submitEvidenceBatch");
  assertEqual(await view.dealAllocationStatus(accepted.dealId), 20n, "allocation status CLAIMED");

  context.state.set("CLAIM_IDS_CSV", claimIds.join(","));
  context.state.set("CLAIM_COUNT", claimIds.length);
  console.log(`  TX: ${txHash}`);
  console.log(`  Claim IDs: ${claimIds.join(",")}`);
  console.log("=== V2 evidence submitted ===");
  return { txHash, claimIds };
}

export async function submitEvidenceBatchAndAssertNoClaimCoverage(
  context: ScenarioContext,
  accepted: AcceptedDeal
): Promise<SubmittedEvidence> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const batchSize = envBigInt(context, "V2_EVIDENCE_BATCH_SIZE", 100n);
  const evidenceData = evm.abiEncode("f(uint256)", batchSize);

  console.log("=== Submit V2 evidence batch with no provider claim ===");
  console.log(`  Deal:       ${accepted.dealId}`);
  console.log(`  Batch size: ${batchSize}`);

  const txHash = await evm.sendWithPrivateKey(
    context.config.identityKeys.porepService,
    context.config.addresses.poRepMarket,
    "submitEvidenceBatch(uint256,bytes)",
    [accepted.dealId, evidenceData],
  );
  const claimIds = await view.claimIds(accepted.dealId);
  assertEqual(claimIds.length, 0, "claim ids before provider claim");
  assertEqual(await view.dealAllocationStatus(accepted.dealId), 10n, "allocation status remains ALLOCATED");

  context.state.set("CLAIM_IDS_CSV", "");
  context.state.set("CLAIM_COUNT", 0);
  console.log(`  TX: ${txHash}`);
  console.log("  Claim IDs: none");
  console.log("=== V2 no-claim evidence batch submitted ===");
  return { txHash, claimIds };
}

export async function activateEvidenceAndAssertDealActive(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  rail: PreparedRail
): Promise<ActiveDeal> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);

  console.log("=== Activate V2 evidence ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Rail: ${rail.railId}`);

  const txHash = await evm.sendWithPrivateKey(
    context.config.identityKeys.porepService,
    context.config.addresses.poRepMarket,
    "activateEvidence(uint256,bytes)",
    [accepted.dealId, "0x"],
  );
  const deal = await view.deal(accepted.dealId);
  assertEqual(deal.state, 30n, `V2 deal ${accepted.dealId} state ACTIVE`);
  const capacity = await view.dealCapacity(accepted.dealId);
  if (capacity.committedBytes <= 0n) throw new Error(`committedBytes expected > 0, got ${capacity.committedBytes}`);
  const currentRail = await view.rail(rail.railId);
  if (currentRail.paymentRate <= 0n) throw new Error(`rail payment rate expected > 0, got ${currentRail.paymentRate}`);

  context.state.set("DEAL_STATE", "ACTIVE");
  context.state.set("COMMITTED_BYTES", capacity.committedBytes);
  context.state.set("PAYMENT_RATE", currentRail.paymentRate);

  console.log(`  TX: ${txHash}`);
  console.log("  Deal state: ACTIVE");
  console.log(`  Committed bytes: ${capacity.committedBytes}`);
  console.log(`  Rail payment rate: ${currentRail.paymentRate}`);
  console.log("=== V2 evidence activated ===");
  return { dealId: accepted.dealId, committedBytes: capacity.committedBytes, paymentRate: currentRail.paymentRate };
}

export async function assertActivationBeforeEvidenceStaysAccepted(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  rail: PreparedRail
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);

  console.log("=== Expect activation before evidence to fail ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Rail: ${rail.railId}`);

  await evm.sendWithPrivateKey(
    context.config.identityKeys.porepService,
    context.config.addresses.poRepMarket,
    "activateEvidence(uint256,bytes)",
    [accepted.dealId, "0x"],
  );

  const deal = await view.deal(accepted.dealId);
  if (deal.state === 30n) {
    throw new Error(`negative scenario failed: deal ${accepted.dealId} became ACTIVE before evidence`);
  }
  assertEqual(deal.state, 20n, `V2 deal ${accepted.dealId} remains ACCEPTED`);
  console.log("Activation was rejected: deal stayed ACCEPTED");
}

export async function expectActivationWithoutClaimCoverageToStayAccepted(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  rail: PreparedRail
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);

  console.log("=== Expect activation without claim coverage to stay ACCEPTED ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Rail: ${rail.railId}`);

  const before = await view.deal(accepted.dealId);
  assertEqual(before.state, 20n, `V2 deal ${accepted.dealId} starts ACCEPTED`);
  await evm.sendWithPrivateKey(
    context.config.identityKeys.porepService,
    context.config.addresses.poRepMarket,
    "activateEvidence(uint256,bytes)",
    [accepted.dealId, "0x"],
  );

  const deal = await view.deal(accepted.dealId);
  const capacity = await view.dealCapacity(accepted.dealId);
  assertEqual(deal.state, 20n, `V2 deal ${accepted.dealId} remains ACCEPTED`);
  assertEqual(capacity.committedBytes, 0n, "committedBytes without claim coverage");
  console.log("Activation was rejected: deal stayed ACCEPTED with zero committed bytes");
}

export async function expectDoubleActivationToFail(
  context: ScenarioContext,
  active: ActiveDeal
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);

  console.log("=== Expect double activation to fail ===");
  console.log(`  Deal: ${active.dealId}`);

  const beforeDeal = await view.deal(active.dealId);
  const beforeCapacity = await view.dealCapacity(active.dealId);
  assertEqual(beforeDeal.state, 30n, `V2 deal ${active.dealId} starts ACTIVE`);
  assertEqual(beforeCapacity.committedBytes, active.committedBytes, "committedBytes before double activation");

  const error = await expectCustomError(
    () => evm.simulateWithPrivateKey(
      context.config.identityKeys.porepService,
      context.config.addresses.poRepMarket,
      "activateEvidence(uint256,bytes)",
      [active.dealId, "0x"],
    ),
    artifactAbis(context).poRepMarket,
    "DealNotInExpectedState"
  );
  assertEqual(error.args[0], active.dealId, "double activation error dealId");
  assertEqual(error.args[1], 30n, "double activation error current state");
  assertEqual(error.args[2], 20n, "double activation error expected state");
  console.log(`  Double activation failed with ${error.name}`);

  const afterDeal = await view.deal(active.dealId);
  const afterCapacity = await view.dealCapacity(active.dealId);
  assertEqual(afterDeal.state, beforeDeal.state, "deal state after double activation attempt");
  assertEqual(afterCapacity.committedBytes, beforeCapacity.committedBytes, "committedBytes after double activation attempt");
  console.log("Expected failure observed for: double activation");
}
