import assert from "node:assert/strict";
import { Evm } from "../contracts/evm.js";
import {
  readCurioPipeline,
  submitCurioNotification,
  waitForCurioCommitFailure,
} from "../devnet/curio.js";
import { generatePieceAndAssertCommp } from "../devnet/piece.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";

const receiverAbi = [
  "function calls() view returns (uint256)",
  "function uniquePieces() view returns (uint256)",
];

export async function runDirectOnboardingNotificationFailure(
  context: ScenarioContext,
): Promise<void> {
  const receiver = new Evm(context).contract(
    context.config.addresses.failingNotificationReceiver,
    receiverAbi,
  );
  const callsBefore = await receiver.calls() as bigint;
  const uniqueBefore = await receiver.uniquePieces() as bigint;
  const piece = await runStep(context, "generate piece", () =>
    generatePieceAndAssertCommp(context));
  const deal = await runStep(context, "submit rejected Curio notification deal", () =>
    submitCurioNotification(context, piece, context.config.addresses.failingNotificationReceiver));
  const failure = await runStep(context, "wait for required notification rejection", () =>
    waitForCurioCommitFailure(context, deal.dealId));
  const pipeline = readCurioPipeline(context, deal.dealId);

  assert.equal(pipeline?.complete, false);
  assert.equal(pipeline?.sealed, false);
  assert.match(
    failure.error,
    /sector change rejected|commit|notification|receiver|prove/i,
  );
  assert.equal(await receiver.calls() as bigint, callsBefore);
  assert.equal(await receiver.uniquePieces() as bigint, uniqueBefore);

  context.state.set("CURIO_DEAL_ID", deal.dealId);
  context.state.set("ALLOC_ID", deal.allocationId);
  context.state.set("SECTOR_NUMBER", failure.sector);
  context.state.set("COMMIT_TASK_ID", failure.taskId);
  context.state.set("REJECTION_ERROR", failure.error);
  context.state.set("NOTIFICATION_ADDRESS", deal.notificationAddress);
  context.state.set("NOTIFICATION_PAYLOAD", deal.notificationPayload);
}
