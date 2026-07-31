import { formatUnits, Wallet } from "ethers";
import { assertEqual } from "../assertions.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm } from "../contracts/evm.js";
import { contracts, type Account } from "../contracts/views.js";
import {
  activateEvidenceAndAssertDealActive,
  submitEvidenceBatchAndAssertClaimCoverage,
} from "../flows/evidence.js";
import {
  finishDataCapPostingAndAssertAllocated,
  generatePiece,
  importPieceAndWaitForProviderClaim,
  submitDataCapAllocation,
} from "../flows/datacap.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import {
  configureSettlementCadenceForDevnet,
  refreshEvidenceStatusAndAssertActive,
  setSliAttestationForDeal,
  settleAccountLockupAtEpoch,
  settleRailAtEpochAndAssertOutcome,
} from "../flows/settlement.js";
import {
  approveValidatorOperatorWithoutDeposit,
  createPreparedRailAndAssertRate,
  createValidatorForDeal,
  depositExactWithPermitForApprovedValidator,
} from "../flows/validatorRail.js";
import { activationPaymentRate, billed32GiBUnits, settlementAmount } from "../expected.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";

const ONE_EPOCH_LOCKUP = 1n;
const FUNDED_WINDOWS = 2n;

export async function runClientFundsExhaustion(context: ScenarioContext): Promise<void> {
  const originalClientKey = context.config.privateKeyTest;
  const freshPayer = Wallet.createRandom();
  const evm = new Evm(context);
  let scenarioFailure: unknown;
  let cleanupFailure: unknown;
  try {
    await evm.ensureEvmActor(
      freshPayer.privateKey,
      100_000_000_000_000_000n,
    );
    context.config.privateKeyTest = freshPayer.privateKey;
    await runIsolatedClientFundsExhaustion(context);
  } catch (error) {
    scenarioFailure = error;
  } finally {
    try {
      await evm.sweepNativeBalance(
        freshPayer.privateKey,
        new Wallet(originalClientKey).address,
      );
    } catch (error) {
      cleanupFailure = error;
    } finally {
      context.config.privateKeyTest = originalClientKey;
    }
  }
  if (scenarioFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [scenarioFailure, cleanupFailure],
      "client-funds-exhaustion failed and native balance recovery also failed",
    );
  }
  if (scenarioFailure !== undefined) throw scenarioFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

async function runIsolatedClientFundsExhaustion(context: ScenarioContext): Promise<void> {
  const evm = new Evm(context);
  const view = contracts(context);
  await runStep(context, "prove isolated payer has no FilecoinPay balance or lockup", async () => {
    const account = await view.account(evm.signerAddress);
    assertEqual(account.funds, 0n, "isolated payer FilecoinPay funds before setup");
    assertEqual(account.lockupCurrent, 0n, "isolated payer FilecoinPay lockup before setup");
    assertEqual(account.lockupRate, 0n, "isolated payer FilecoinPay lockup rate before setup");
    assertEqual(await view.tokenBalance(evm.signerAddress), 0n, "isolated payer MockUSDC before setup");
  });

  const offer = await runStep(context, "register provider and offer", () => registerDevnetProviderAndOffer(context));
  const deal = await runStep(context, "propose accepted deal", () => proposeDealAndAssertAccepted(context, offer));
  await runStep(context, "set SLI attestation before activation", () => setSliAttestationForDeal(context, deal));
  await runStep(context, "configure one-epoch settlement cadence before activation", () => configureSettlementCadenceForDevnet(context, deal));
  const validator = await runStep(context, "deploy validator", () => createValidatorForDeal(context, deal));
  await runStep(context, "approve validator operator without deposit", () =>
    approveValidatorOperatorWithoutDeposit(context, validator),
  );
  const rail = await runStep(context, "create prepared rail", () => createPreparedRailAndAssertRate(context, deal, validator));
  await runStep(context, "reduce prepared rail lockup to one epoch", async () => {
    await evm.sendWithPrivateKey(
      context.config.identityKeys.deployer,
      validator.validator,
      "updateLockupPeriod(uint256)",
      [ONE_EPOCH_LOCKUP],
    );
  });
  const piece = await runStep(context, "generate piece", () => generatePiece(context));
  const allocation = await runStep(context, "submit DataCap allocation", () => submitDataCapAllocation(context, deal, piece));
  await runStep(context, "import piece and wait for provider claim", () => importPieceAndWaitForProviderClaim(context, allocation));
  await runStep(context, "finish DataCap posting", () => finishDataCapPostingAndAssertAllocated(context, deal));
  await runStep(context, "submit evidence batch", () => submitEvidenceBatchAndAssertClaimCoverage(context, deal));

  const exactDeposit = await runStep(context, "mint and deposit the exact lockup plus funded windows", async () => {
    const expectedCommittedBytes = allocation.piece.pieceSize;
    const rate = activationPaymentRate(offer.pricePer32GiBPerMonth, expectedCommittedBytes);
    const amount = rate * (ONE_EPOCH_LOCKUP + FUNDED_WINDOWS);
    await mintExactMockUsdc(context, amount);
    const result = await depositExactWithPermitForApprovedValidator(context, validator, formatUnits(amount, 6));
    assertEqual(result.depositAmount, amount, "exact bounded FilecoinPay deposit");
    assertEqual(await view.tokenBalance(evm.signerAddress), 0n, "isolated payer MockUSDC after exact deposit");
    return { amount, rate, expectedCommittedBytes };
  });

  const active = await runStep(context, "activate evidence", () => activateEvidenceAndAssertDealActive(context, deal, rail));
  assertEqual(active.committedBytes, exactDeposit.expectedCommittedBytes, "activated committed bytes from the submitted provider claim");
  assertEqual(active.paymentRate, exactDeposit.rate, "activated rail rate used for bounded deposit");
  await runStep(context, "refresh evidence status", () => refreshEvidenceStatusAndAssertActive(context, active));

  const funded = await runStep(context, "settle through the exact funded lockup cutoff", async () => {
    const beforeRail = await view.rail(rail.railId);
    const beforeAccount = await view.account(beforeRail.from);
    const service = await view.dealService(deal.dealId);
    if (beforeAccount.lockupRate <= 0n || beforeAccount.funds < beforeAccount.lockupCurrent) {
      throw new Error(`invalid payer lockup before funded settlement: funds=${beforeAccount.funds}, current=${beforeAccount.lockupCurrent}, rate=${beforeAccount.lockupRate}`);
    }
    const fundedCutoff = beforeAccount.lockupLastSettledAt
      + ((beforeAccount.funds - beforeAccount.lockupCurrent) / beforeAccount.lockupRate);
    if (fundedCutoff <= beforeRail.settledUpTo) {
      throw new Error(`funded cutoff ${fundedCutoff} must be after rail cursor ${beforeRail.settledUpTo}`);
    }
    await evm.waitForBlock(fundedCutoff);
    const payment = await view.dealPayment(deal.dealId);
    const expectedGross = settlementAmount(
      payment.pricePer32GiBPerMonth,
      billed32GiBUnits(active.committedBytes),
      service.startEpoch,
      beforeRail.settledUpTo,
      fundedCutoff,
    );
    const projectedLockup = settleAccountLockupAtEpoch(beforeAccount, fundedCutoff);
    const result = await settleRailAtEpochAndAssertOutcome(
      context,
      deal,
      rail,
      fundedCutoff,
      { settlementAmount: expectedGross, settleUpto: fundedCutoff, note: "payment validated successfully" },
      fundedCutoff,
    );
    const expectedAccount = {
      funds: projectedLockup.funds - expectedGross,
      lockupCurrent: projectedLockup.lockupCurrent - (exactDeposit.rate * (fundedCutoff - beforeRail.settledUpTo)),
      lockupRate: exactDeposit.rate,
      lockupLastSettledAt: fundedCutoff,
    };
    assertAccountEqual(await view.account(beforeRail.from), expectedAccount, "payer at funded cutoff");
    return { fromEpoch: result.fromEpoch, cutoff: fundedCutoff, expectedGross };
  });

  await runStep(context, "prove exhaustion returns exact zero-progress result without state change", async () => {
    const beforeRail = await view.rail(rail.railId);
    const beforeService = await view.dealService(deal.dealId);
    const beforePayer = await view.account(beforeRail.from);
    const beforePayee = await view.account(beforeRail.to);
    const targetEpoch = beforeRail.settledUpTo + 1n;
    await evm.waitForBlock(targetEpoch);
    const result = await evm.contract(context.config.addresses.filecoinPay, artifactAbis(context).filecoinPay).settleRail.staticCall(
      rail.railId,
      targetEpoch,
      { from: evm.signerAddress },
    ) as unknown[];
    assertEqual(BigInt(result[0] as bigint), 0n, "zero-progress gross settlement");
    assertEqual(BigInt(result[1] as bigint), 0n, "zero-progress net payee settlement");
    assertEqual(BigInt(result[2] as bigint), 0n, "zero-progress operator commission");
    assertEqual(BigInt(result[3] as bigint), 0n, "zero-progress network fee");
    assertEqual(BigInt(result[4] as bigint), beforeRail.settledUpTo, "zero-progress final cursor");
    assertEqual(String(result[5]), `already settled up to epoch ${beforePayer.lockupLastSettledAt}`, "zero-progress note");
    await evm.send(context.config.addresses.filecoinPay, "settleRail(uint256,uint256)", [rail.railId, targetEpoch]);
    assertEqual((await view.rail(rail.railId)).settledUpTo, beforeRail.settledUpTo, "FilecoinPay cursor after zero progress");
    assertEqual((await view.dealService(deal.dealId)).lastSettledEpoch, beforeService.lastSettledEpoch, "PoRep Market cursor after zero progress");
    assertAccountEqual(await view.account(beforeRail.from), beforePayer, "payer after zero progress");
    assertAccountEqual(await view.account(beforeRail.to), beforePayee, "payee after zero progress");
  });

  await runStep(context, "mint and top up the same payer by one exact epoch", async () => {
    await mintExactMockUsdc(context, exactDeposit.rate);
    const result = await depositExactWithPermitForApprovedValidator(context, validator, formatUnits(exactDeposit.rate, 6));
    assertEqual(result.depositAmount, exactDeposit.rate, "same-account recovery top-up");
  });
  await runStep(context, "resume settlement from the preserved cursor", async () => {
    const beforeRail = await view.rail(rail.railId);
    const beforeAccount = await view.account(beforeRail.from);
    const targetEpoch = beforeRail.settledUpTo + 1n;
    await evm.waitForBlock(targetEpoch);
    const payment = await view.dealPayment(deal.dealId);
    const service = await view.dealService(deal.dealId);
    const expectedGross = settlementAmount(
      payment.pricePer32GiBPerMonth,
      billed32GiBUnits(active.committedBytes),
      service.startEpoch,
      beforeRail.settledUpTo,
      targetEpoch,
    );
    const result = await settleRailAtEpochAndAssertOutcome(
      context,
      deal,
      rail,
      targetEpoch,
      { settlementAmount: expectedGross, settleUpto: targetEpoch, note: "payment validated successfully" },
      targetEpoch,
    );
    assertEqual(result.fromEpoch, funded.cutoff, "resumed settlement starts at prior FilecoinPay cursor");
    const afterRail = await view.rail(rail.railId);
    assertEqual(afterRail.settledUpTo, targetEpoch, "resumed FilecoinPay cursor");
    assertEqual((await view.dealService(deal.dealId)).lastSettledEpoch, targetEpoch, "resumed PoRep Market cursor");
    if (beforeAccount.lockupLastSettledAt < beforeRail.settledUpTo) {
      throw new Error(`recovery account lockup cursor ${beforeAccount.lockupLastSettledAt} is before rail cursor ${beforeRail.settledUpTo}`);
    }
  });
}

async function mintExactMockUsdc(context: ScenarioContext, amount: bigint): Promise<void> {
  const evm = new Evm(context);
  const view = contracts(context);
  const balance = await view.tokenBalance(evm.signerAddress);
  assertEqual(balance, 0n, "isolated payer MockUSDC before exact mint");
  await evm.send(context.config.addresses.usdcToken, "mint(address,uint256)", [evm.signerAddress, amount]);
  assertEqual(await view.tokenBalance(evm.signerAddress), amount, "isolated payer exact MockUSDC mint");
}

function assertAccountEqual(actual: Account, expected: Account, label: string): void {
  assertEqual(actual.funds, expected.funds, `${label} funds`);
  assertEqual(actual.lockupCurrent, expected.lockupCurrent, `${label} lockup current`);
  assertEqual(actual.lockupRate, expected.lockupRate, `${label} lockup rate`);
  assertEqual(actual.lockupLastSettledAt, expected.lockupLastSettledAt, `${label} lockup last settled at`);
}
