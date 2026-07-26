import assert from "node:assert/strict";
import { Evm } from "../contracts/evm.js";
import {
  submitCurioNotification,
  waitForCurioSector,
} from "../devnet/curio.js";
import { generatePieceAndAssertCommp } from "../devnet/piece.js";
import { recordActiveSectorFixture } from "../fixtures/activeSector.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import { sleep } from "../shell.js";

const receiverAbi = [
  "function calls() view returns (uint256)",
  "function uniquePieces() view returns (uint256)",
  "function lastSector() view returns (uint64)",
  "function lastPieceDigest() view returns (bytes32)",
  "function lastPaddedSize() view returns (uint64)",
  "function lastPayload() view returns (bytes)",
];

export async function runDirectOnboardingNotification(context: ScenarioContext): Promise<void> {
  const receiverBefore = await runStep(context, "read notification receiver baseline", () =>
    readReceiver(context));
  const piece = await runStep(context, "generate piece", () =>
    generatePieceAndAssertCommp(context));
  const deal = await runStep(context, "submit Curio notification deal", () =>
    submitCurioNotification(context, piece, context.config.addresses.notificationReceiver));
  const pipeline = await runStep(context, "wait for Curio sector", () =>
    waitForCurioSector(context, deal.dealId));
  const receiver = await runStep(context, "read notification receiver", () =>
    waitForReceiver(context, receiverBefore));

  assert.equal(pipeline.allocationId, Number(deal.allocationId));
  assert.equal(receiver.calls, receiverBefore.calls + 1n);
  assert.equal(receiver.uniquePieces, receiverBefore.uniquePieces + 1n);
  assert.equal(receiver.sector, BigInt(pipeline.sector!));
  assert.equal(receiver.paddedSize, piece.pieceSize);
  assert.equal(receiver.pieceDigest.toLowerCase(), `0x${piece.pieceCidHex.slice(-64)}`.toLowerCase());
  assert.equal(receiver.payload.toLowerCase(), `0x${deal.notificationPayload}`.toLowerCase());

  context.state.set("CURIO_DEAL_ID", deal.dealId);
  context.state.set("ALLOC_ID", deal.allocationId);
  context.state.set("SECTOR_NUMBER", pipeline.sector!);
  context.state.set("NOTIFICATION_ADDRESS", deal.notificationAddress);
  context.state.set("NOTIFICATION_PAYLOAD", deal.notificationPayload);
  await recordActiveSectorFixture(
    context,
    pipeline.sector!,
    piece.pieceCid,
  );
}

type ReceiverState = {
  calls: bigint;
  uniquePieces: bigint;
  sector: bigint;
  pieceDigest: string;
  paddedSize: bigint;
  payload: string;
};

async function readReceiver(context: ScenarioContext): Promise<ReceiverState> {
  const receiver = new Evm(context).contract(
    context.config.addresses.notificationReceiver,
    receiverAbi,
  );
  return {
    calls: await receiver.calls() as bigint,
    uniquePieces: await receiver.uniquePieces() as bigint,
    sector: await receiver.lastSector() as bigint,
    pieceDigest: await receiver.lastPieceDigest() as string,
    paddedSize: await receiver.lastPaddedSize() as bigint,
    payload: await receiver.lastPayload() as string,
  };
}

async function waitForReceiver(
  context: ScenarioContext,
  baseline: ReceiverState,
): Promise<ReceiverState> {
  for (let attempt = 1; attempt <= 120; attempt++) {
    const state = await readReceiver(context);
    if (state.calls > baseline.calls && state.uniquePieces > baseline.uniquePieces) return state;
    await sleep(5000);
  }
  throw new Error("notification receiver was not called within 10 minutes");
}
