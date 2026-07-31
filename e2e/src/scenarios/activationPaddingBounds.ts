import { assertEqual } from "../assertions.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm } from "../contracts/evm.js";
import {
  ContractRevertError,
  assertCustomError,
  expectRevertOnSend,
} from "../contracts/reverts.js";
import { contracts } from "../contracts/views.js";
import {
  generatePiece,
  submitDataCapAllocation,
} from "../flows/datacap.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import {
  createPreparedRailAndAssertRate,
  createValidatorForDeal,
  depositAndApproveValidatorOperator,
} from "../flows/validatorRail.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";

const MAX_DEAL_ACTIVATION_PADDING = 10_000n;
const HALF_SIZE_PADDING = 5_000n;

export async function runActivationPaddingBounds(context: ScenarioContext): Promise<void> {
  const evm = new Evm(context);
  const view = contracts(context);
  const market = evm.contract(context.config.addresses.poRepMarket, artifactAbis(context).poRepMarket);
  const originalPadding = BigInt((await market.getDealActivationPadding()).toString());
  const previousRequestedSize = context.config.env.V2_REQUESTED_SIZE_BYTES;

  try {
    await runStep(context, "prove activation padding above 10000 bps is rejected", async () => {
      const attemptedPadding = MAX_DEAL_ACTIVATION_PADDING + 1n;
      const error = await expectRevertOnSend(
        evm,
        context.config.identityKeys.deployer,
        context.config.addresses.poRepMarket,
        "setDealActivationPadding(uint256)",
        [attemptedPadding],
        artifactAbis(context).poRepMarket,
        "DealActivationPaddingTooHigh",
      );
      assertEqual(error.args[0], attemptedPadding, "rejected activation padding");
      assertEqual(error.args[1], MAX_DEAL_ACTIVATION_PADDING, "maximum activation padding");
      assertEqual(
        BigInt((await market.getDealActivationPadding()).toString()),
        originalPadding,
        "activation padding after rejected update",
      );
    });

    await runStep(context, "set and read 5000 bps activation padding", async () => {
      await evm.sendWithPrivateKey(
        context.config.identityKeys.deployer,
        context.config.addresses.poRepMarket,
        "setDealActivationPadding(uint256)",
        [HALF_SIZE_PADDING],
      );
      assertEqual(
        BigInt((await market.getDealActivationPadding()).toString()),
        HALF_SIZE_PADDING,
        "configured activation padding",
      );
    });

    const piece = await runStep(context, "generate padding-bound piece", () => generatePiece(context));
    context.config.env.V2_REQUESTED_SIZE_BYTES = (piece.pieceSize * 2n).toString();
    const offer = await runStep(context, "register provider and offer for padding-bound deal", () =>
      registerDevnetProviderAndOffer(context));
    const deal = await runStep(context, "propose deal requesting twice the piece size", () =>
      proposeDealAndAssertAccepted(context, offer));
    const validator = await runStep(context, "deploy padding-bound validator", () =>
      createValidatorForDeal(context, deal));
    await runStep(context, "deposit and approve padding-bound validator", () =>
      depositAndApproveValidatorOperator(context, deal, validator));
    await runStep(context, "create padding-bound prepared rail", () =>
      createPreparedRailAndAssertRate(context, deal, validator));
    await runStep(context, "submit half-size DataCap allocation", () =>
      submitDataCapAllocation(context, deal, piece));

    await runStep(context, "finish posting at the configured lower allocation bound", async () => {
      assertEqual(
        await view.dataCapAllocatedBytes(deal.dealId),
        piece.pieceSize,
        "allocated bytes at padding bound",
      );
      assertEqual(
        (await view.dealTerms(deal.dealId)).requestedSizeBytes,
        piece.pieceSize * 2n,
        "requested bytes above padding bound",
      );
      const outcome = await evm.sendWithPrivateKeyAllowRevert(
        context.config.privateKeyTest,
        context.config.addresses.dataCapEvidenceAdapter,
        "finishDataCapPosting(uint256)",
        [deal.dealId],
      );
      if (outcome.receipt.status !== "0x1") {
        if (!outcome.revertData) {
          throw new Error("expected padding-bound posting to succeed, but the mined revert had no recoverable data");
        }
        const pinnedError = assertCustomError(
          new ContractRevertError(outcome.revertData),
          artifactAbis(context).dataCapEvidenceAdapter,
          "InvalidAllocatedBytes",
        );
        throw new Error(
          `intended PR #116 padding-bound posting should succeed, but the pinned deployment reverted with ${pinnedError.name}`,
        );
      }
      assertEqual(await view.dataCapPostingFinished(deal.dealId), true, "padding-bound posting finished");
      assertEqual(await view.dealAllocationStatus(deal.dealId), 10n, "padding-bound allocation status");
    });
  } finally {
    if (previousRequestedSize === undefined) {
      delete context.config.env.V2_REQUESTED_SIZE_BYTES;
    } else {
      context.config.env.V2_REQUESTED_SIZE_BYTES = previousRequestedSize;
    }
    const currentPadding = BigInt((await market.getDealActivationPadding()).toString());
    if (currentPadding !== originalPadding) {
      await evm.sendWithPrivateKey(
        context.config.identityKeys.deployer,
        context.config.addresses.poRepMarket,
        "setDealActivationPadding(uint256)",
        [originalPadding],
      );
    }
  }
}
