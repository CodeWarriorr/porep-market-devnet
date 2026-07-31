import { MaxUint256 } from "ethers";
import { assertEqual } from "../assertions.js";
import type { ScenarioContext } from "../runtime.js";
import { defaultDepositAmountHuman } from "../runtime.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm, lower, requireAddress } from "../contracts/evm.js";
import { contracts, type Rail } from "../contracts/views.js";
import { signDepositPermit } from "../contracts/permit.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
import type { AcceptedDeal } from "./deal.js";
import { requireDevnet } from "../devnet/docker.js";

export type DealValidator = {
  validator: string;
  txHash: string;
};

export type PreparedRail = {
  railId: bigint;
  rail: Rail;
};

export async function createValidatorForDeal(
  context: ScenarioContext,
  accepted: AcceptedDeal
): Promise<DealValidator> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);

  console.log("Creating V2 validator...");
  console.log(`Factory: ${context.config.addresses.validatorFactory}`);
  console.log(`Sender:  ${evm.signerAddress}`);
  console.log(`DealId:  ${accepted.dealId}`);

  const txHash = await evm.send(context.config.addresses.validatorFactory, "create(uint256)", [accepted.dealId]);
  const validator = requireAddress(await view.validatorForDeal(accepted.dealId), `validator for deal ${accepted.dealId}`);
  const deal = await view.deal(accepted.dealId);
  assertEqual(lower(deal.validator), lower(validator), "deal validator");

  context.state.set("VALIDATOR", validator);
  console.log(`Validator created: ${validator}`);
  return { validator, txHash };
}

export async function depositAndApproveValidatorOperator(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  validator: DealValidator
): Promise<{ txHash: string; depositAmount: bigint }> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const depositAmountHuman = defaultDepositAmountHuman(context);
  const permit = await signDepositPermit(context, context.config.addresses.filecoinPay, depositAmountHuman);
  const balance = await view.tokenBalance(evm.signerAddress);
  const missing = missingTokenAmount(balance, permit.amount);

  if (missing > 0n) {
    console.log(`  Minting ${missing} MockUSDC needed for this deposit`);
    await evm.send(context.config.addresses.usdcToken, "mint(address,uint256)", [evm.signerAddress, missing]);
    assertEqual(await view.tokenBalance(evm.signerAddress) >= permit.amount, true, "USDC balance after top-up");
  }

  console.log("Depositing and approving V2 validator operator...");
  console.log(`  Client=${evm.signerAddress}`);
  console.log(`  Deal ID=${accepted.dealId}`);
  console.log(`  Validator=${validator.validator}`);
  console.log(`  Token=${context.config.addresses.usdcToken}`);
  console.log(`  Amount=${permit.amount}`);

  const txHash = await evm.send(
    context.config.addresses.filecoinPay,
    "depositWithPermitAndApproveOperator(address,address,uint256,uint256,uint8,bytes32,bytes32,address,uint256,uint256,uint256)",
    [
      context.config.addresses.usdcToken,
      evm.signerAddress,
      permit.amount,
      permit.deadline,
      permit.v,
      permit.r,
      permit.s,
      validator.validator,
      MaxUint256,
      MaxUint256,
      MaxUint256
    ]
  );

  assertEqual(await view.operatorApproved(evm.signerAddress, validator.validator), true, `operator approval for ${validator.validator}`);
  console.log(`TX: ${txHash}`);
  console.log(`Operator approved: ${validator.validator}`);
  return { txHash, depositAmount: permit.amount };
}

export function requireSufficientTokenBalance(balance: bigint, exactDepositAmount: bigint): void {
  if (balance < exactDepositAmount) {
    throw new Error(
      `exact bounded deposit requires ${exactDepositAmount} MockUSDC, but client has ${balance}`,
    );
  }
}

export async function approveValidatorOperatorWithoutDeposit(
  context: ScenarioContext,
  validator: DealValidator,
): Promise<string> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const txHash = await evm.send(
    context.config.addresses.filecoinPay,
    "setOperatorApproval(address,address,bool,uint256,uint256,uint256)",
    [
      context.config.addresses.usdcToken,
      validator.validator,
      true,
      MaxUint256,
      MaxUint256,
      MaxUint256,
    ],
  );
  assertEqual(await view.operatorApproved(evm.signerAddress, validator.validator), true, `operator approval for ${validator.validator}`);
  return txHash;
}

export async function depositExactWithPermitForApprovedValidator(
  context: ScenarioContext,
  validator: DealValidator,
  depositAmountHuman: string,
): Promise<{ txHash: string; depositAmount: bigint }> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const permit = await signDepositPermit(context, context.config.addresses.filecoinPay, depositAmountHuman);
  requireSufficientTokenBalance(await view.tokenBalance(evm.signerAddress), permit.amount);
  const txHash = await evm.send(
    context.config.addresses.filecoinPay,
    "depositWithPermitAndIncreaseOperatorApproval(address,address,uint256,uint256,uint8,bytes32,bytes32,address,uint256,uint256)",
    [
      context.config.addresses.usdcToken,
      evm.signerAddress,
      permit.amount,
      permit.deadline,
      permit.v,
      permit.r,
      permit.s,
      validator.validator,
      0n,
      0n,
    ],
  );
  return { txHash, depositAmount: permit.amount };
}

export function missingTokenAmount(balance: bigint, required: bigint): bigint {
  return balance < required ? required - balance : 0n;
}

export async function createPreparedRailAndAssertRate(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  validator: DealValidator
): Promise<PreparedRail> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);

  console.log("Creating V2 prepared rail...");
  console.log(`Validator: ${validator.validator}`);

  await evm.send(validator.validator, "createRail()");
  const deal = await view.deal(accepted.dealId);
  assertEqual(deal.railId > 0n, true, "deal railId set");
  assertEqual(await view.validatorRailStatus(validator.validator), 10n, "rail status PREPARED");

  const rail = await view.rail(deal.railId);
  context.state.set("RAIL_ID", deal.railId);
  console.log(`Prepared rail created: ${deal.railId}`);
  return { railId: deal.railId, rail };
}

export async function expectRailCreationWithoutOperatorApprovalToFail(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  validator: DealValidator
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const beforeDeal = await view.deal(accepted.dealId);
  const approved = await view.operatorApproved(evm.signerAddress, validator.validator);

  console.log("=== Expect V2 rail creation without operator approval to fail ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Client: ${evm.signerAddress}`);
  console.log(`  Validator/operator: ${validator.validator}`);
  console.log(`  Operator approved: ${approved}`);

  assertEqual(beforeDeal.railId, 0n, "rail id before unapproved rail creation");
  assertEqual(approved, false, "operator approval before unapproved rail creation");

  const error = await expectRevertOnSend(
    evm,
    context.config.privateKeyTest,
    validator.validator,
    "createRail()",
    [],
    artifactAbis(context).validator,
    "OperatorNotApproved"
  );
  console.log(`  Rail creation failed with ${error.name}`);

  const afterDeal = await view.deal(accepted.dealId);
  assertEqual(afterDeal.railId, 0n, "rail id after unapproved rail creation");
  assertEqual(afterDeal.state, beforeDeal.state, "deal state after unapproved rail creation");
  console.log("Expected failure observed for: rail creation without operator approval");
}
