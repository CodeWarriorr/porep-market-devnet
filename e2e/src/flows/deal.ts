import { id as keccakText } from "ethers";
import { assertEqual } from "../assertions.js";
import type { ScenarioContext } from "../runtime.js";
import { envBigInt, envNumber, envValue } from "../runtime.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm, lower } from "../contracts/evm.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
import { contracts, type Deal, type DealSlis } from "../contracts/views.js";
import { PUBLIC_DEAL_TYPE } from "../expected.js";
import type { ProviderOffer } from "./provider.js";
import { requireDevnet } from "../devnet/docker.js";

export type AcceptedDeal = {
  dealId: bigint;
  deal: Deal;
  requestedSizeBytes: bigint;
  durationEpochs: bigint;
  slis: DealSlis;
};

export type ProposalManifest = {
  location: string;
  hash: string;
};

export function nextProposalManifest(context: ScenarioContext): ProposalManifest {
  const explicitLocation = envValue(context, "V2_MANIFEST_LOCATION");
  const location = explicitLocation || defaultProposalManifestLocation(context);
  return {
    location,
    hash: envValue(context, "V2_MANIFEST_HASH", keccakText(location))
  };
}

export async function proposeDealAndAssertAccepted(
  context: ScenarioContext,
  offer?: ProviderOffer
): Promise<AcceptedDeal> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const abi = artifactAbis(context);
  const retrievability = envBigInt(context, "V2_RETRIEVABILITY_BPS", 10_000n);
  const bandwidth = envBigInt(context, "V2_BANDWIDTH_BYTES_PER_SECOND", 1_048_576n);
  const price = envBigInt(context, "V2_PRICE_PER_32GIB_MONTH", 86_400_000_000n);
  const durationDays = envNumber(context, "V2_DURATION_DAYS", 180);
  const requestedSize = envBigInt(context, "V2_REQUESTED_SIZE_BYTES", 2048n);
  const latency = envBigInt(context, "V2_LATENCY_MS", 100n);
  const indexing = envBigInt(context, "V2_INDEXING_PCT", 100n);
  const paymentToken = envValue(context, "V2_PAYMENT_TOKEN", context.config.addresses.usdcToken);
  const dealType = envBigInt(context, "V2_DEAL_TYPE", PUBLIC_DEAL_TYPE);
  const manifest = nextProposalManifest(context);

  console.log("Proposing V2 deal...");
  const txHash = await evm.send(
    context.config.addresses.poRepMarket,
    "proposeDeal((bytes32,uint256,uint256,string,address,uint32,uint8,(uint16,uint64,uint16,uint8)))",
    [
      `(${manifest.hash},${requestedSize},${price},${manifest.location},${paymentToken},${durationDays},${dealType},(${retrievability},${bandwidth},${latency},${indexing}))`
    ]
  );
  console.log(`TX: ${txHash}`);

  const event = evm.parseEvent(evm.receipt(txHash), abi.poRepMarket, "DealCreated");
  const dealId = BigInt(event.args[0].toString());
  const deal = await view.deal(dealId);
  const data = await view.dealData(dealId);
  const terms = await view.dealTerms(dealId);
  const capacity = await view.dealCapacity(dealId);
  const payment = await view.dealPayment(dealId);
  const slis = await view.dealSlis(dealId);

  assertEqual(deal.state, 20n, `V2 deal ${dealId} state`);
  assertEqual(lower(deal.evidenceAdapter), lower(context.config.addresses.dataCapEvidenceAdapter), "evidence adapter");
  assertEqual(deal.dealType, dealType, "deal type");
  assertEqual(deal.proposedAtEpoch, BigInt(evm.receipt(txHash).blockNumber), "proposedAtEpoch");
  assertEqual(deal.offerId > 0n, true, "deal froze provider offer id");
  assertEqual(lower(data.manifestHash), lower(manifest.hash), "manifestHash");
  assertEqual(data.manifestLocation, manifest.location, "manifestLocation");
  assertEqual(terms.requestedSizeBytes, requestedSize, "requestedSizeBytes");
  assertEqual(terms.durationEpochs, BigInt(durationDays) * 2880n, "durationEpochs");
  assertEqual(capacity.reservedBytes, requestedSize, "reservedBytes");
  assertEqual(capacity.committedBytes, 0n, "committedBytes before activation");
  assertEqual(lower(payment.token), lower(paymentToken), "paymentToken");
  assertEqual(payment.pricePer32GiBPerMonth, price, "pricePer32GiBPerMonth");
  assertEqual(slis.retrievabilityBps, retrievability, "retrievabilityBps");
  assertEqual(slis.bandwidthBytesPerSecond, bandwidth, "bandwidthBytesPerSecond");
  assertEqual(slis.latencyMs, latency, "latencyMs");
  assertEqual(slis.indexingAvailabilityPct, indexing, "indexingPct");

  if (offer) {
    assertEqual(deal.provider, offer.provider, "deal provider");
    assertEqual(deal.offerId, offer.offerId, "deal offer");
  }

  context.state.set("DEAL_ID", dealId);
  console.log(`DealCreated event caught, dealId = ${dealId}`);
  console.log(`provider: ${deal.provider}`);
  console.log(`offerId: ${deal.offerId}`);
  console.log("state: 20 (ACCEPTED)");

  return { dealId, deal, requestedSizeBytes: requestedSize, durationEpochs: terms.durationEpochs, slis };
}

export async function expectDealProposalWithMismatchedPaymentTokenToFail(
  context: ScenarioContext,
  offer: ProviderOffer
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const unsupportedToken = "0x000000000000000000000000000000000000dEaD";
  const manifest = nextProposalManifest(context);
  const requestedSize = envBigInt(context, "V2_REQUESTED_SIZE_BYTES", 2048n);
  const price = envBigInt(context, "V2_PRICE_PER_32GIB_MONTH", 86_400_000_000n);
  const durationDays = envNumber(context, "V2_DURATION_DAYS", 180);
  const retrievability = envBigInt(context, "V2_RETRIEVABILITY_BPS", 10_000n);
  const bandwidth = envBigInt(context, "V2_BANDWIDTH_BYTES_PER_SECOND", 1_048_576n);
  const latency = envBigInt(context, "V2_LATENCY_MS", 100n);
  const indexing = envBigInt(context, "V2_INDEXING_PCT", 100n);
  const dealType = envBigInt(context, "V2_DEAL_TYPE", PUBLIC_DEAL_TYPE);
  const beforeOffer = await view.offerView(offer.offerId);

  console.log("=== Expect V2 proposal with mismatched payment token to fail ===");
  console.log(`  Offer: ${offer.offerId}`);
  console.log(`  Offer token: ${offer.paymentToken}`);
  console.log(`  Proposal token: ${unsupportedToken}`);
  console.log("  Expected boundary: SPRegistry cannot match an offer payment row for the unsupported token");

  const error = await expectRevertOnSend(
    evm,
    context.config.privateKeyTest,
    context.config.addresses.poRepMarket,
    "proposeDeal((bytes32,uint256,uint256,string,address,uint32,uint8,(uint16,uint64,uint16,uint8)))",
    [
      `(${manifest.hash},${requestedSize},${price},${manifest.location},${unsupportedToken},${durationDays},${dealType},(${retrievability},${bandwidth},${latency},${indexing}))`
    ],
    artifactAbis(context).spRegistry,
    "NoOfferMatched"
  );
  console.log(`  Mismatched-token proposal failed with ${error.name}`);

  const afterOffer = await view.offerView(offer.offerId);
  assertEqual(BigInt(afterOffer[1].toString()), BigInt(beforeOffer[1].toString()), "offer provider after mismatched-token proposal");
  assertEqual(Boolean(afterOffer[2]), Boolean(beforeOffer[2]), "offer active after mismatched-token proposal");
  assertEqual(String(afterOffer[5]), String(beforeOffer[5]), "offer payments after mismatched-token proposal");
  console.log("Expected failure observed for: mismatched payment token proposal");
}

function defaultProposalManifestLocation(context: ScenarioContext): string {
  const nextIndex = BigInt(context.state.get("PROPOSAL_MANIFEST_INDEX") ?? "0") + 1n;
  context.state.set("PROPOSAL_MANIFEST_INDEX", nextIndex);
  return `https://example.com/porep-v2-e2e/${context.runId}/proposal-${nextIndex}/manifest.json`;
}
