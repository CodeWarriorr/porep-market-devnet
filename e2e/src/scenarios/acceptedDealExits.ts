import assert from "node:assert/strict";
import { assertEqual } from "../assertions.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm } from "../contracts/evm.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
import { contracts } from "../contracts/views.js";
import {
  createPreparedRailAndAssertRate,
  createValidatorForDeal,
  depositAndApproveValidatorOperator,
} from "../flows/validatorRail.js";
import { generatePiece, submitDataCapAllocation } from "../flows/datacap.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";

export async function runAcceptedDealRejection(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer for accepted-deal rejection", () =>
    registerDevnetProviderAndOffer(context));
  const view = contracts(context);
  const evm = new Evm(context);
  const beforeRejectionCapacity = await runStep(context, "snapshot provider capacity before rejectable deal", () =>
    view.providerCapacity(offer.provider));
  const rejectableDeal = await runStep(context, "propose rejectable accepted deal", () =>
    proposeDealAndAssertAccepted(context, offer));

  await runStep(context, "assert accepted deal reserves pending capacity", async () => {
    const capacity = await view.providerCapacity(offer.provider);
    assertEqual(capacity.availableBytes, beforeRejectionCapacity.availableBytes, "available bytes after accepted proposal");
    assertEqual(
      capacity.pendingBytes,
      beforeRejectionCapacity.pendingBytes + rejectableDeal.requestedSizeBytes,
      "pending bytes after accepted proposal",
    );
    assertEqual(capacity.committedBytes, beforeRejectionCapacity.committedBytes, "committed bytes after accepted proposal");
  });

  await runStep(context, "reject accepted deal without rail", async () => {
    await evm.sendWithPrivateKey(
      context.config.identityKeys.deployer,
      context.config.addresses.poRepMarket,
      "rejectAcceptedDeal(uint256)",
      [rejectableDeal.dealId],
    );
    assertEqual((await view.deal(rejectableDeal.dealId)).state, 50n, "rejectable deal state");
    assert.deepEqual(
      await view.providerCapacity(offer.provider),
      beforeRejectionCapacity,
      "provider capacity after rejecting accepted deal",
    );
  });

  const railDeal = await runStep(context, "propose accepted deal with prepared rail", () =>
    proposeDealAndAssertAccepted(context, offer));
  const validator = await runStep(context, "deploy validator for non-rejectable accepted deal", () =>
    createValidatorForDeal(context, railDeal));
  await runStep(context, "deposit and approve non-rejectable validator", () =>
    depositAndApproveValidatorOperator(context, railDeal, validator));
  const rail = await runStep(context, "create prepared rail for non-rejectable deal", () =>
    createPreparedRailAndAssertRate(context, railDeal, validator));

  await runStep(context, "prove prepared-rail accepted deal cannot be rejected", async () => {
    const beforeDeal = await view.deal(railDeal.dealId);
    const beforeDealCapacity = await view.dealCapacity(railDeal.dealId);
    const beforeProviderCapacity = await view.providerCapacity(offer.provider);
    const beforeRail = await view.rail(rail.railId);
    const error = await expectRevertOnSend(
      evm,
      context.config.identityKeys.deployer,
      context.config.addresses.poRepMarket,
      "rejectAcceptedDeal(uint256)",
      [railDeal.dealId],
      artifactAbis(context).poRepMarket,
      "DealNotRejectable",
    );
    assertEqual(BigInt(error.args[0].toString()), railDeal.dealId, "DealNotRejectable deal id");
    assert.deepEqual(await view.deal(railDeal.dealId), beforeDeal, "deal after rejected rejectAcceptedDeal");
    assert.deepEqual(await view.dealCapacity(railDeal.dealId), beforeDealCapacity, "deal capacity after rejected rejectAcceptedDeal");
    assert.deepEqual(await view.providerCapacity(offer.provider), beforeProviderCapacity, "provider capacity after rejected rejectAcceptedDeal");
    assert.deepEqual(await view.rail(rail.railId), beforeRail, "rail after rejected rejectAcceptedDeal");
  });
}

export async function runAcceptedDealExpiration(context: ScenarioContext): Promise<void> {
  const offer = await runStep(context, "register provider and offer for accepted-deal expiration", () =>
    registerDevnetProviderAndOffer(context));
  const view = contracts(context);
  const evm = new Evm(context);
  const beforeCapacity = await runStep(context, "snapshot provider capacity before expiring deal", () =>
    view.providerCapacity(offer.provider));
  const deal = await runStep(context, "propose accepted deal for allocation expiration", () =>
    proposeDealAndAssertAccepted(context, offer));
  const validator = await runStep(context, "deploy validator for allocation expiration", () =>
    createValidatorForDeal(context, deal));
  await runStep(context, "deposit and approve allocation-expiration validator", () =>
    depositAndApproveValidatorOperator(context, deal, validator));
  const rail = await runStep(context, "create prepared rail for allocation expiration", () =>
    createPreparedRailAndAssertRate(context, deal, validator));

  const expiration = evm.blockNumber() + 60n;
  await runStep(context, "submit allocation with bounded expiration", async () => {
    const previousExpiration = context.config.env.ALLOCATION_EXPIRATION;
    const previousProcessExpiration = process.env.ALLOCATION_EXPIRATION;
    context.config.env.ALLOCATION_EXPIRATION = expiration.toString();
    process.env.ALLOCATION_EXPIRATION = expiration.toString();
    try {
      await submitDataCapAllocation(context, deal, generatePiece(context));
    } finally {
      if (previousExpiration === undefined) {
        delete context.config.env.ALLOCATION_EXPIRATION;
      } else {
        context.config.env.ALLOCATION_EXPIRATION = previousExpiration;
      }
      if (previousProcessExpiration === undefined) {
        delete process.env.ALLOCATION_EXPIRATION;
      } else {
        process.env.ALLOCATION_EXPIRATION = previousProcessExpiration;
      }
    }
    const adapter = evm.contract(context.config.addresses.dataCapEvidenceAdapter, [
      "function getExpiration(uint256) view returns (int64)",
    ]);
    assertEqual(BigInt((await adapter.getExpiration(deal.dealId)).toString()), expiration, "recorded allocation expiration");
    assertEqual(evm.blockNumber() < expiration, true, "allocation unexpired before close guard");
  });

  await runStep(context, "prove unexpired allocation cannot close accepted deal", async () => {
    const beforeDeal = await view.deal(deal.dealId);
    const beforeDealCapacity = await view.dealCapacity(deal.dealId);
    const beforeProviderCapacity = await view.providerCapacity(offer.provider);
    const beforeRail = await view.rail(rail.railId);
    const error = await expectRevertOnSend(
      evm,
      context.config.identityKeys.porepService,
      context.config.addresses.poRepMarket,
      "terminateDeal(uint256,uint8)",
      [deal.dealId, 60],
      ["error EvidenceNotExpired(uint256 dealId)"],
      "EvidenceNotExpired",
    );
    assertEqual(BigInt(error.args[0].toString()), deal.dealId, "EvidenceNotExpired deal id");
    assert.deepEqual(await view.deal(deal.dealId), beforeDeal, "deal after unexpired close attempt");
    assert.deepEqual(await view.dealCapacity(deal.dealId), beforeDealCapacity, "deal capacity after unexpired close attempt");
    assert.deepEqual(await view.providerCapacity(offer.provider), beforeProviderCapacity, "provider capacity after unexpired close attempt");
    assert.deepEqual(await view.rail(rail.railId), beforeRail, "rail after unexpired close attempt");
  });

  await runStep(context, "expire allocation and close accepted deal", async () => {
    await evm.waitForBlock(expiration + 1n);
    const txHash = await evm.sendWithPrivateKey(
      context.config.identityKeys.porepService,
      context.config.addresses.poRepMarket,
      "terminateDeal(uint256,uint8)",
      [deal.dealId, 60],
    );
    const receipt = evm.receipt(txHash);
    assertEqual((await view.deal(deal.dealId)).state, 60n, "expired deal state");
    assertEqual(await view.validatorRailStatus(validator.validator), 100n, "expired deal rail status");
    assertEqual(
      (await view.dealService(deal.dealId)).earlyTerminationEpoch,
      BigInt(receipt.blockNumber),
      "expired deal early termination epoch",
    );
    assert.deepEqual(await view.providerCapacity(offer.provider), beforeCapacity, "provider capacity after allocation expiration");
  });
}
