import { id as keccakText, type Result } from "ethers";
import { assertEqual } from "../assertions.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm } from "../contracts/evm.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
import { contracts } from "../contracts/views.js";
import {
  proposeDealAndAssertAccepted,
} from "../flows/deal.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import {
  createPreparedRailAndAssertRate,
  createValidatorForDeal,
  depositAndApproveValidatorOperator,
} from "../flows/validatorRail.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";

const MANIFEST_ALREADY_ASSIGNED = 12n;

export async function runDuplicateManifestLifecycle(context: ScenarioContext): Promise<void> {
  const evm = new Evm(context);
  const view = contracts(context);
  const previousLocation = context.config.env.V2_MANIFEST_LOCATION;
  const previousHash = context.config.env.V2_MANIFEST_HASH;
  const manifestLocation = `https://example.com/porep-v2-e2e/${context.runId}/shared-manifest.json`;

  context.config.env.V2_MANIFEST_LOCATION = manifestLocation;
  context.config.env.V2_MANIFEST_HASH = keccakText(manifestLocation);

  try {
    const offer = await runStep(context, "register provider and offer for duplicate manifest", () =>
      registerDevnetProviderAndOffer(context));
    const initialCapacity = await view.providerCapacity(offer.provider);
    const first = await runStep(context, "propose first deal with shared manifest", () =>
      proposeDealAndAssertAccepted(context, offer));
    const firstData = await view.dealData(first.dealId);
    const firstPayment = await view.dealPayment(first.dealId);
    const request = proposalRequest(
      first,
      firstData.manifestHash,
      firstPayment.token,
      firstPayment.pricePer32GiBPerMonth,
      firstData.manifestLocation,
    );

    await runStep(context, "prove duplicate manifest proposal is rejected", async () => {
      const preview = await evm.contract(
        context.config.addresses.spRegistry,
        artifactAbis(context).spRegistry,
      ).previewOfferForDeal(offer.offerId, request) as Result;
      assertEqual(BigInt(preview[1].toString()), MANIFEST_ALREADY_ASSIGNED, "duplicate manifest preview reason");
      const capacityBeforeDuplicate = await view.providerCapacity(offer.provider);
      const error = await expectRevertOnSend(
        evm,
        context.config.privateKeyTest,
        context.config.addresses.poRepMarket,
        "proposeDeal((bytes32,uint256,uint256,string,address,uint32,uint8,(uint16,uint64,uint16,uint8)))",
        [proposalRequestArgument(request)],
        artifactAbis(context).spRegistry,
        "NoOfferMatched",
      );
      assertEqual(error.args.length, 0, "duplicate manifest rejection arguments");
      assertProviderCapacityEqual(
        await view.providerCapacity(offer.provider),
        capacityBeforeDuplicate,
        "provider capacity after duplicate manifest rejection",
      );
      assertEqual((await view.deal(first.dealId)).state, 20n, "first deal state after duplicate rejection");
    });

    const validator = await runStep(context, "deploy first shared-manifest validator", () =>
      createValidatorForDeal(context, first));
    await runStep(context, "deposit and approve first shared-manifest validator", () =>
      depositAndApproveValidatorOperator(context, first, validator));
    await runStep(context, "create first shared-manifest prepared rail", () =>
      createPreparedRailAndAssertRate(context, first, validator));

    await runStep(context, "terminate first deal and release shared manifest", async () => {
      await evm.sendWithPrivateKey(
        context.config.identityKeys.porepService,
        context.config.addresses.poRepMarket,
        "terminateDeal(uint256,uint8)",
        [first.dealId, 70n],
      );
      assertEqual((await view.deal(first.dealId)).state, 70n, "first shared-manifest deal state");
      assertProviderCapacityEqual(
        await view.providerCapacity(offer.provider),
        initialCapacity,
        "provider capacity after shared-manifest termination",
      );
      const preview = await evm.contract(
        context.config.addresses.spRegistry,
        artifactAbis(context).spRegistry,
      ).previewOfferForDeal(offer.offerId, request) as Result;
      assertEqual(BigInt(preview[1].toString()), 0n, "released manifest preview reason");
    });

    await runStep(context, "repropose released shared manifest", async () => {
      const reproposed = await proposeDealAndAssertAccepted(context, offer);
      assertEqual(
        (await view.dealData(reproposed.dealId)).manifestHash.toLowerCase(),
        firstManifestHash(request).toLowerCase(),
        "reproposed manifest hash",
      );
      const capacity = await view.providerCapacity(offer.provider);
      assertEqual(
        capacity.pendingBytes,
        initialCapacity.pendingBytes + reproposed.requestedSizeBytes,
        "pending capacity after shared-manifest reproposal",
      );
    });
  } finally {
    if (previousLocation === undefined) {
      delete context.config.env.V2_MANIFEST_LOCATION;
    } else {
      context.config.env.V2_MANIFEST_LOCATION = previousLocation;
    }
    if (previousHash === undefined) {
      delete context.config.env.V2_MANIFEST_HASH;
    } else {
      context.config.env.V2_MANIFEST_HASH = previousHash;
    }
  }
}

type ProposalRequest = readonly [
  string,
  bigint,
  bigint,
  string,
  string,
  bigint,
  bigint,
  readonly [bigint, bigint, bigint, bigint],
];

function proposalRequest(
  deal: Awaited<ReturnType<typeof proposeDealAndAssertAccepted>>,
  manifestHash: string,
  paymentToken: string,
  pricePer32GiBPerMonth: bigint,
  manifestLocation: string,
): ProposalRequest {
  return [
    manifestHash,
    deal.requestedSizeBytes,
    pricePer32GiBPerMonth,
    manifestLocation,
    paymentToken,
    deal.durationEpochs / 2_880n,
    deal.deal.dealType,
    [
      deal.slis.retrievabilityBps,
      deal.slis.bandwidthBytesPerSecond,
      deal.slis.latencyMs,
      deal.slis.indexingAvailabilityPct,
    ],
  ];
}

function proposalRequestArgument(request: ProposalRequest): string {
  return `(${request[0]},${request[1]},${request[2]},${request[3]},${request[4]},${request[5]},${request[6]},(${request[7].join(",")}))`;
}

function firstManifestHash(request: ProposalRequest): string {
  return request[0];
}

function assertProviderCapacityEqual(
  actual: { availableBytes: bigint; committedBytes: bigint; pendingBytes: bigint },
  expected: { availableBytes: bigint; committedBytes: bigint; pendingBytes: bigint },
  label: string,
): void {
  assertEqual(actual.availableBytes, expected.availableBytes, `${label} available bytes`);
  assertEqual(actual.committedBytes, expected.committedBytes, `${label} committed bytes`);
  assertEqual(actual.pendingBytes, expected.pendingBytes, `${label} pending bytes`);
}
