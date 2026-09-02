import { assertEqual } from "../assertions.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm } from "../contracts/evm.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";

const MAX_DEAL_ACTIVATION_PADDING = 2_000n;

export async function runActivationPaddingBounds(context: ScenarioContext): Promise<void> {
  const evm = new Evm(context);
  const market = evm.contract(context.config.addresses.poRepMarket, artifactAbis(context).poRepMarket);
  const originalPadding = BigInt((await market.getDealActivationPadding()).toString());

  try {
    await runStep(context, "prove activation padding above 2000 bps is rejected", async () => {
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

    await runStep(context, "set and read 2000 bps activation padding", async () => {
      await evm.sendWithPrivateKey(
        context.config.identityKeys.deployer,
        context.config.addresses.poRepMarket,
        "setDealActivationPadding(uint256)",
        [MAX_DEAL_ACTIVATION_PADDING],
      );
      assertEqual(
        BigInt((await market.getDealActivationPadding()).toString()),
        MAX_DEAL_ACTIVATION_PADDING,
        "configured activation padding",
      );
    });
  } finally {
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
