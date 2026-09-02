import { assertEqual } from "../assertions.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm } from "../contracts/evm.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
import {
  assertDataCapGuardStateUnchanged,
  dataCapBatchCalldata,
  dataCapGuardState,
  generatePiece,
  replaceDataCapBatchOperatorData,
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

const malformedOperatorData = [
  { label: "wrong top-level arity", payload: "0x8180", error: "InvalidOperatorData" },
  { label: "wrong allocation arity", payload: "0x828187", error: "InvalidAllocationRequest" },
  { label: "wrong extension arity", payload: "0x82808182", error: "InvalidClaimExtensionRequest" },
  { label: "truncated bytes", payload: "0x82" },
  { label: "nested junk", payload: "0x828181818180", error: "InvalidAllocationRequest" },
  { label: "empty top-level array", payload: "0x80", error: "InvalidOperatorData" },
] as const;

export async function runDataCapMalformedInput(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer for malformed DataCap input", () =>
    registerDevnetProviderAndOffer(context),
  );
  const deal = await runStep(context, "propose accepted malformed DataCap input deal", () =>
    proposeDealAndAssertAccepted(context, offer),
  );
  const validator = await runStep(context, "deploy validator for malformed DataCap input deal", () =>
    createValidatorForDeal(context, deal),
  );
  await runStep(context, "deposit and approve malformed DataCap input validator operator", () =>
    depositAndApproveValidatorOperator(context, deal, validator),
  );
  await runStep(context, "create prepared rail for malformed DataCap input deal", () =>
    createPreparedRailAndAssertRate(context, deal, validator),
  );
  const piece = await runStep(context, "generate piece for malformed DataCap input", () => generatePiece(context));
  const validCalldata = dataCapBatchCalldata(context, {
    provider: deal.deal.provider,
    pieceSize: piece.pieceSize,
    dealId: deal.dealId,
    pieceCidHex: piece.pieceCidHex,
  });
  const evm = new Evm(context);
  const adapterAbi = artifactAbis(context).dataCapEvidenceAdapter;
  const failures: string[] = [];

  for (const malformed of malformedOperatorData) {
    await runStep(context, `reject malformed DataCap operator data: ${malformed.label}`, async () => {
      const before = await dataCapGuardState(context, deal.dealId);
      const calldata = replaceDataCapBatchOperatorData(adapterAbi, validCalldata, malformed.payload);
      try {
        if ("error" in malformed) {
          const error = await expectRevertOnSend(
            evm,
            context.config.privateKeyTest,
            context.config.addresses.dataCapEvidenceAdapter,
            calldata,
            [],
            adapterAbi,
            malformed.error,
          );
          assertEqual(error.args.length, 0, `${malformed.label} error arguments`);
        } else {
          const outcome = await evm.sendWithPrivateKeyAllowRevert(
            context.config.privateKeyTest,
            context.config.addresses.dataCapEvidenceAdapter,
            calldata,
          );
          assertEqual(outcome.receipt.status, "0x0", `${malformed.label} transaction status`);
        }
      } catch (error) {
        failures.push(`${malformed.label}: ${error instanceof Error ? error.message : String(error)}`);
      }
      assertDataCapGuardStateUnchanged(
        await dataCapGuardState(context, deal.dealId),
        before,
        `state after malformed DataCap operator data: ${malformed.label}`,
      );
    });
  }

  await runStep(context, "submit valid DataCap batch after malformed input reverts", async () => {
    const before = await dataCapGuardState(context, deal.dealId);
    await evm.send(context.config.addresses.dataCapEvidenceAdapter, validCalldata);
    const after = await dataCapGuardState(context, deal.dealId);
    assertEqual(after.allocationIds.length, before.allocationIds.length + 1, "valid batch adds one allocation id");
    assertEqual(after.allocatedBytes, before.allocatedBytes + piece.pieceSize, "valid batch allocates the piece size");
    assertEqual(after.postingFinished, false, "valid batch leaves posting open");
    assertEqual(after.operational, true, "adapter remains operational after malformed input reverts");
  });

  if (failures.length > 0) {
    throw new Error(`malformed DataCap operator-data guard mismatches:\n${failures.join("\n")}`);
  }
}
