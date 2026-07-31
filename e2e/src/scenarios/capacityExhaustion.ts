import { assertEqual } from "../assertions.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm } from "../contracts/evm.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
import { contracts, type Deal } from "../contracts/views.js";
import { nextProposalManifest } from "../flows/deal.js";
import {
  registerDevnetProviderAndOffer,
  remainingProviderCapacity,
} from "../flows/provider.js";
import type { ScenarioContext } from "../runtime.js";
import { envBigInt, envNumber, envValue, runStep } from "../runtime.js";
import { PUBLIC_DEAL_TYPE } from "../expected.js";

const INSUFFICIENT_CAPACITY = 11n;

export async function runCapacityExhaustion(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer without capacity growth", () =>
    registerDevnetProviderAndOffer(context, { preserveAvailableCapacity: true }),
  );
  const view = contracts(context);
  const requestedSize = envBigInt(context, "V2_REQUESTED_SIZE_BYTES", 2048n);
  const before = await view.providerCapacity(offer.provider);
  const selectedAvailableBytes = before.committedBytes + before.pendingBytes + (2n * requestedSize);

  await runStep(context, "set selected provider capacity", async () => {
    const evm = new Evm(context);
    await evm.sendWithPrivateKey(
      context.config.identityKeys.operator,
      context.config.addresses.spRegistry,
      "updateAvailableSpace(uint64,uint256)",
      [offer.provider, selectedAvailableBytes],
    );
    const after = await view.providerCapacity(offer.provider);
    assertEqual(after.availableBytes, selectedAvailableBytes, "selected provider available bytes");
    assertEqual(after.committedBytes, before.committedBytes, "provider committed bytes before reservations");
    assertEqual(after.pendingBytes, before.pendingBytes, "provider pending bytes before reservations");
  });

  const first = await runStep(context, "reserve first accepted deal at selected offer", () =>
    proposeAcceptedDealAtSpecificOffer(context, offer.offerId),
  );
  await runStep(context, "assert first reservation capacity", async () => {
    const capacity = await view.providerCapacity(offer.provider);
    assertEqual(capacity.availableBytes, selectedAvailableBytes, "available bytes after first reservation");
    assertEqual(capacity.committedBytes, before.committedBytes, "committed bytes after first reservation");
    assertEqual(capacity.pendingBytes, before.pendingBytes + requestedSize, "pending bytes after first reservation");
    assertEqual(remainingProviderCapacity(capacity), requestedSize, "remaining bytes after first reservation");
  });

  const second = await runStep(context, "reserve second accepted deal at selected offer", () =>
    proposeAcceptedDealAtSpecificOffer(context, offer.offerId),
  );
  await runStep(context, "assert capacity exactly exhausted by accepted reservations", async () => {
    const capacity = await view.providerCapacity(offer.provider);
    assertEqual(capacity.availableBytes, selectedAvailableBytes, "available bytes after second reservation");
    assertEqual(capacity.committedBytes, before.committedBytes, "committed bytes after second reservation");
    assertEqual(capacity.pendingBytes, before.pendingBytes + (2n * requestedSize), "pending bytes after second reservation");
    assertEqual(remainingProviderCapacity(capacity), 0n, "remaining bytes after second reservation");
  });

  await runStep(context, "reject the over-capacity specific-offer proposal without state change", async () => {
    const evm = new Evm(context);
    const capacityBeforeRevert = await view.providerCapacity(offer.provider);
    const firstBeforeRevert = await view.deal(first.dealId);
    const secondBeforeRevert = await view.deal(second.dealId);
    const request = specificOfferRequest(context);
    const error = await expectRevertOnSend(
      evm,
      context.config.identityKeys.deployer,
      context.config.addresses.poRepMarket,
      "proposeDealWithSpecificOffer(uint256,(bytes32,uint256,uint256,string,address,uint32,uint8,(uint16,uint64,uint16,uint8)))",
      [offer.offerId, request],
      artifactAbis(context).spRegistry,
      "OfferNotEligible",
    );
    assertEqual(BigInt(error.args[0].toString()), offer.offerId, "over-capacity offer id");
    assertEqual(BigInt(error.args[1].toString()), INSUFFICIENT_CAPACITY, "over-capacity reason");

    const capacityAfterRevert = await view.providerCapacity(offer.provider);
    const firstAfterRevert = await view.deal(first.dealId);
    const secondAfterRevert = await view.deal(second.dealId);
    assertEqual(capacityAfterRevert.availableBytes, capacityBeforeRevert.availableBytes, "available bytes after over-capacity revert");
    assertEqual(capacityAfterRevert.committedBytes, capacityBeforeRevert.committedBytes, "committed bytes after over-capacity revert");
    assertEqual(capacityAfterRevert.pendingBytes, capacityBeforeRevert.pendingBytes, "pending bytes after over-capacity revert");
    assertDealEqual(firstAfterRevert, firstBeforeRevert, "first deal after over-capacity revert");
    assertDealEqual(secondAfterRevert, secondBeforeRevert, "second deal after over-capacity revert");
    assertEqual((await view.dealCapacity(first.dealId)).reservedBytes, requestedSize, "first deal reserved bytes after over-capacity revert");
    assertEqual((await view.dealCapacity(first.dealId)).committedBytes, 0n, "first deal committed bytes after over-capacity revert");
    assertEqual((await view.dealCapacity(second.dealId)).reservedBytes, requestedSize, "second deal reserved bytes after over-capacity revert");
    assertEqual((await view.dealCapacity(second.dealId)).committedBytes, 0n, "second deal committed bytes after over-capacity revert");
  });
}

function specificOfferRequest(context: ScenarioContext): string {
  const manifest = nextProposalManifest(context);
  const requestedSize = envBigInt(context, "V2_REQUESTED_SIZE_BYTES", 2048n);
  const price = envBigInt(context, "V2_PRICE_PER_32GIB_MONTH", 86_400_000_000n);
  const durationDays = envNumber(context, "V2_DURATION_DAYS", 180);
  const dealType = envBigInt(context, "V2_DEAL_TYPE", PUBLIC_DEAL_TYPE);
  const token = envValue(context, "V2_PAYMENT_TOKEN", context.config.addresses.usdcToken);
  const retrievability = envBigInt(context, "V2_RETRIEVABILITY_BPS", 10_000n);
  const bandwidth = envBigInt(context, "V2_BANDWIDTH_BYTES_PER_SECOND", 1_048_576n);
  const latency = envBigInt(context, "V2_LATENCY_MS", 100n);
  const indexing = envBigInt(context, "V2_INDEXING_PCT", 100n);
  return `(${manifest.hash},${requestedSize},${price},${manifest.location},${token},${durationDays},${dealType},(${retrievability},${bandwidth},${latency},${indexing}))`;
}

async function proposeAcceptedDealAtSpecificOffer(
  context: ScenarioContext,
  offerId: bigint,
): Promise<{ dealId: bigint }> {
  const evm = new Evm(context);
  const txHash = await evm.sendWithPrivateKey(
    context.config.identityKeys.deployer,
    context.config.addresses.poRepMarket,
    "proposeDealWithSpecificOffer(uint256,(bytes32,uint256,uint256,string,address,uint32,uint8,(uint16,uint64,uint16,uint8)))",
    [offerId, specificOfferRequest(context)],
  );
  const dealId = BigInt(evm.parseEvent(
    evm.receipt(txHash),
    artifactAbis(context).poRepMarket,
    "DealCreated",
  ).args[0].toString());
  const deal = await contracts(context).deal(dealId);
  assertEqual(deal.state, 20n, `specific-offer deal ${dealId} state`);
  assertEqual(deal.offerId, offerId, `specific-offer deal ${dealId} offer`);
  return { dealId };
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
