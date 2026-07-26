import type { Result } from "ethers";
import { assertEqual } from "../assertions.js";
import type { ScenarioContext } from "../runtime.js";
import { envBigInt, envValue } from "../runtime.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm, lower } from "../contracts/evm.js";
import { contracts } from "../contracts/views.js";
import { requireDevnet } from "../devnet/docker.js";

export type ProviderOffer = {
  provider: bigint;
  providerPayee: string;
  offerId: bigint;
  paymentToken: string;
  pricePer32GiBPerMonth: bigint;
};

export async function registerDevnetProviderAndOffer(context: ScenarioContext): Promise<ProviderOffer> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const abi = artifactAbis(context);
  const provider = envBigInt(context, "MINER_ACTOR_ID", BigInt(context.config.provider.slice(2)));
  const providerPayee = envValue(context, "V2_PROVIDER_PAYEE") ||
    context.config.identityAddresses.providerPayee;
  const operatorKey = context.config.identityKeys.operator;
  const paymentToken = envValue(context, "V2_PAYMENT_TOKEN", context.config.addresses.usdcToken);
  const price = envBigInt(context, "V2_PRICE_PER_32GIB_MONTH", 86_400_000_000n);
  const availableBytes = envBigInt(context, "V2_AVAILABLE_BYTES", 1_073_741_824n);
  const minPrice = envBigInt(context, "V2_MIN_PRICE_PER_32GIB_MONTH", 1n);

  if (lower(providerPayee) === lower(evm.signerAddress)) {
    throw new Error("V2 provider payee must differ from client/deployer for payout assertions");
  }

  console.log("=== Register V2 provider in SPRegistry ===");
  console.log("Current PoRep Market V2 uses provider registration plus offer-based matching.");

  if (await view.providerRegistered(provider)) {
    console.log(`Provider ${provider} already registered, preserving used capacity`);
    const capacity = await view.providerCapacity(provider);
    const requiredCapacity = capacityFloor(capacity, availableBytes);
    if (capacity.availableBytes < requiredCapacity) {
      await evm.sendWithPrivateKey(
        operatorKey,
        context.config.addresses.spRegistry,
        "updateAvailableSpace(uint64,uint256)",
        [provider, requiredCapacity],
      );
    }
    if (lower(await view.providerPayee(provider)) !== lower(providerPayee)) {
      await evm.sendWithPrivateKey(
        operatorKey,
        context.config.addresses.spRegistry,
        "setPayee(uint64,address)",
        [provider, providerPayee],
      );
    }
  } else {
    await evm.sendWithPrivateKey(operatorKey, context.config.addresses.spRegistry, "registerProviderFor(uint64,address,uint256,address)", [
      provider,
      context.config.identityAddresses.operator,
      availableBytes,
      providerPayee
    ]);
  }

  assertEqual(await view.providerRegistered(provider), true, `provider ${provider} registered`);
  const tokenConfig = await view.paymentTokenConfig(paymentToken);
  assertEqual(Boolean(tokenConfig[0]), true, "payment token allowed");
  assertEqual(BigInt(tokenConfig[1].toString()) <= minPrice, true, "payment token minimum price");

  let existingOffer: bigint | undefined;
  for (const id of await view.providerOfferIds(provider)) {
    if (id > 0n && offerMatches(context, await view.offerView(id, paymentToken))) {
      existingOffer = id;
      break;
    }
  }
  let offerId: bigint;
  if (existingOffer !== undefined) {
    offerId = existingOffer;
    const existing = await view.offerView(offerId, paymentToken);
    if (offerPaymentNeedsUpdate(Boolean(existing[6]), BigInt(existing[7].toString()), price)) {
      console.log(`Provider ${provider} already has offer ${offerId}, updating payment row`);
      await evm.sendWithPrivateKey(operatorKey, context.config.addresses.spRegistry, "setOfferPayment(uint256,address,bool,uint256)", [
        offerId,
        paymentToken,
        true,
        price
      ]);
    } else {
      console.log(`Provider ${provider} already has matching offer ${offerId}`);
    }
  } else {
    const txHash = await evm.sendWithPrivateKey(
      operatorKey,
      context.config.addresses.spRegistry,
      "createOffer(uint64,(uint256,uint256,uint64,uint64),(uint16,uint64,uint16,uint8),(address,bool,uint256)[])",
      [
        provider,
        offerTerms(context),
        offerSlis(context),
        `[(${paymentToken},true,${price})]`
      ]
    );
    const event = evm.parseEvent(evm.receipt(txHash), abi.spRegistry, "OfferCreated");
    offerId = BigInt(event.args[0].toString());
  }

  const offer = await view.offerView(offerId, paymentToken);
  assertEqual(BigInt(offer[1].toString()), provider, "offer provider");
  assertEqual(Boolean(offer[2]), true, "offer active");
  assertEqual(Boolean(offer[6]), true, "offer payment active");
  assertEqual(BigInt(offer[7].toString()), price, "offer price");

  context.state.set("PROVIDER", provider);
  context.state.set("PROVIDER_PAYEE", providerPayee);
  context.state.set("OFFER_ID", offerId);
  console.log(`Provider ${provider} registered with offer ${offerId} for token ${paymentToken} at price ${price} and payee ${providerPayee}.`);

  return { provider, providerPayee, offerId, paymentToken, pricePer32GiBPerMonth: price };
}

export function capacityFloor(
  current: {
    availableBytes: bigint;
    committedBytes: bigint;
    pendingBytes: bigint;
  },
  requestedHeadroom: bigint,
): bigint {
  const needed = current.committedBytes + current.pendingBytes + requestedHeadroom;
  return current.availableBytes > needed ? current.availableBytes : needed;
}

export function offerPaymentNeedsUpdate(
  active: boolean,
  currentPrice: bigint,
  requestedPrice: bigint,
): boolean {
  return !active || currentPrice !== requestedPrice;
}

function offerMatches(context: ScenarioContext, offer: Result): boolean {
  const terms = offer[3] as Result;
  const slis = offer[4] as Result;
  return Boolean(offer[2])
    && BigInt(terms[0].toString()) === envBigInt(context, "V2_MIN_SIZE_BYTES", 1n)
    && BigInt(terms[1].toString()) === envBigInt(context, "V2_MAX_SIZE_BYTES", 0n)
    && BigInt(terms[2].toString()) === envBigInt(context, "V2_MIN_DURATION_EPOCHS", 518_400n)
    && BigInt(terms[3].toString()) === envBigInt(context, "V2_MAX_DURATION_EPOCHS", 3_680_640n)
    && BigInt(slis[0].toString()) === envBigInt(context, "V2_RETRIEVABILITY_BPS", 10_000n)
    && BigInt(slis[1].toString()) === envBigInt(context, "V2_BANDWIDTH_BYTES_PER_SECOND", 1_048_576n)
    && BigInt(slis[2].toString()) === envBigInt(context, "V2_LATENCY_MS", 100n)
    && BigInt(slis[3].toString()) === envBigInt(context, "V2_INDEXING_PCT", 100n);
}

function offerTerms(context: ScenarioContext): string {
  const minSize = envBigInt(context, "V2_MIN_SIZE_BYTES", 1n);
  const maxSize = envBigInt(context, "V2_MAX_SIZE_BYTES", 0n);
  const minDuration = envBigInt(context, "V2_MIN_DURATION_EPOCHS", 518_400n);
  const maxDuration = envBigInt(context, "V2_MAX_DURATION_EPOCHS", 3_680_640n);
  return `(${minSize},${maxSize},${minDuration},${maxDuration})`;
}

function offerSlis(context: ScenarioContext): string {
  const retrievability = envBigInt(context, "V2_RETRIEVABILITY_BPS", 10_000n);
  const bandwidth = envBigInt(context, "V2_BANDWIDTH_BYTES_PER_SECOND", 1_048_576n);
  const latency = envBigInt(context, "V2_LATENCY_MS", 100n);
  const indexing = envBigInt(context, "V2_INDEXING_PCT", 100n);
  return `(${retrievability},${bandwidth},${latency},${indexing})`;
}
