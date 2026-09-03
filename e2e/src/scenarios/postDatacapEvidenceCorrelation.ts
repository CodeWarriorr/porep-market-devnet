import assert from "node:assert/strict";
import { AbiCoder, keccak256 } from "ethers";
import { Evm } from "../contracts/evm.js";
import { contracts } from "../contracts/views.js";
import {
  decodePostDataCapNotificationPayload,
  submitCurioNotification,
  waitForCurioSector,
} from "../devnet/curio.js";
import { generatePieceAndAssertCommp } from "../devnet/piece.js";
import { recordActiveSectorFixture } from "../fixtures/activeSector.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import { sleep } from "../shell.js";
import { validateSectorStatus } from "./sectorStatus.js";

const receiverAbi = [
  "function expectedMiner() view returns (address)",
  "function calls() view returns (uint256)",
  "function uniquePieces() view returns (uint256)",
  "function lastSector() view returns (uint64)",
  "function lastMinimumCommitmentEpoch() view returns (int64)",
  "function lastPieceDigest() view returns (bytes32)",
  "function lastPaddedSize() view returns (uint64)",
  "function lastPayload() view returns (bytes)",
];

export function pieceSetCommitment(pieceCidDigest: string, paddedSize: bigint): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint64"],
    [pieceCidDigest, paddedSize],
  ));
}

export async function runPostDatacapEvidenceCorrelation(
  context: ScenarioContext,
): Promise<void> {
  const receiverBefore = await runStep(context, "read notification receiver baseline", () =>
    readReceiver(context));
  const piece = await runStep(context, "generate piece", () =>
    generatePieceAndAssertCommp(context));
  const pieceDigest = `0x${piece.pieceCidHex.slice(-64)}`;
  const pieceCommitment = pieceSetCommitment(pieceDigest, piece.pieceSize);
  const deal = await runStep(context, "propose piece-bound PoRep deal", () =>
    proposeDealAndAssertAccepted(
      dealContext(context, piece.pieceSize),
      undefined,
      pieceCommitment,
    ));
  const dealData = await runStep(context, "read accepted PoRep deal binding", () =>
    contracts(context).dealData(deal.dealId));
  const curioDeal = await runStep(context, "submit joined Curio notification deal", () =>
    submitCurioNotification(
      context,
      piece,
      context.config.addresses.notificationReceiver,
      deal.dealId,
    ));
  const pipeline = await runStep(context, "wait for Curio sector", () =>
    waitForCurioSector(context, curioDeal.dealId));
  const receiver = await runStep(context, "read joined notification receiver", () =>
    waitForReceiver(context, receiverBefore));

  assert.match(context.config.provider, /^t0\d+$/);
  const providerId = BigInt(context.config.provider.slice(2));
  const expectedMiner = `0xff${providerId.toString(16).padStart(38, "0")}`;
  const decodedPayload = decodePostDataCapNotificationPayload(receiver.payload);
  const callbackSector = Number(receiver.sector);

  assert.equal(deal.deal.provider, providerId);
  assert.equal(dealData.manifestHash.toLowerCase(), pieceCommitment.toLowerCase());
  assert.equal(decodedPayload.allocationId, curioDeal.allocationId);
  assert.equal(decodedPayload.porepDealId, deal.dealId);
  assert.equal(receiver.expectedMiner.toLowerCase(), expectedMiner);
  assert.equal(receiver.calls, receiverBefore.calls + 1n);
  assert.equal(receiver.uniquePieces, receiverBefore.uniquePieces + 1n);
  assert.equal(receiver.pieceDigest.toLowerCase(), pieceDigest.toLowerCase());
  assert.equal(receiver.paddedSize, piece.pieceSize);
  assert.equal(
    receiver.payload.toLowerCase(),
    `0x${curioDeal.notificationPayload}`.toLowerCase(),
  );
  assert.equal(
    receiver.minimumCommitmentEpoch >= deal.deal.proposedAtEpoch + deal.durationEpochs,
    true,
  );
  assert.equal(Number.isSafeInteger(callbackSector), true);
  assert.equal(callbackSector, pipeline.sector);
  assert.equal(pipeline.allocationId, Number(curioDeal.allocationId));

  const fixture = await runStep(context, "record callback sector location", () =>
    recordActiveSectorFixture(context, callbackSector, piece.pieceCid));
  const active = await runStep(context, "validate callback sector as active", () =>
    validateSectorStatus(
      context,
      deal.dealId,
      callbackSector,
      1,
      fixture.deadline,
      fixture.partition,
    ));
  assert.equal(active, true);

  context.state.set("POREP_DEAL_ID", deal.dealId);
  context.state.set("POREP_PROVIDER", deal.deal.provider);
  context.state.set("PIECE_SET_COMMITMENT", pieceCommitment);
  context.state.set("CURIO_DEAL_ID", curioDeal.dealId);
  context.state.set("ALLOC_ID", curioDeal.allocationId);
  context.state.set("NOTIFICATION_ADDRESS", curioDeal.notificationAddress);
  context.state.set("NOTIFICATION_PAYLOAD", curioDeal.notificationPayload);
  context.state.set("NOTIFICATION_PAYLOAD_VERSION", 2);
  context.state.set("NOTIFICATION_ALLOCATION_ID", decodedPayload.allocationId);
  context.state.set("NOTIFICATION_POREP_DEAL_ID", decodedPayload.porepDealId);
  context.state.set("AUTHENTICATED_NOTIFICATION_SENDER", receiver.expectedMiner);
  context.state.set("CALLBACK_PIECE_DIGEST", receiver.pieceDigest);
  context.state.set("CALLBACK_PADDED_SIZE", receiver.paddedSize);
  context.state.set("CALLBACK_MINIMUM_COMMITMENT_EPOCH", receiver.minimumCommitmentEpoch);
  context.state.set("CALLBACK_SECTOR", callbackSector);
  context.state.set("SECTOR_NUMBER", callbackSector);
  context.state.set("SECTOR_DEADLINE", fixture.deadline);
  context.state.set("SECTOR_PARTITION", fixture.partition);
  context.state.set("SECTOR_STATUS_CLAIMED", 1);
  context.state.set("SECTOR_STATUS_ACTIVE", String(active));
  context.state.set(
    "EVIDENCE_RECORD_SCOPE",
    "correlated observation; not an authenticated adapter binding",
  );
  context.state.set(
    "CURRENT_PIECE_MEMBERSHIP",
    "skipped: no current actor query proves PieceCID membership",
  );
  context.state.set(
    "FIP_0083_RECONCILIATION",
    "skipped: actor-event projection is not implemented in this harness",
  );
  context.state.set(
    "NOMINAL_SECTOR_EXPIRATION",
    "skipped: the pinned inspector exposes status only",
  );
}

type ReceiverState = {
  expectedMiner: string;
  calls: bigint;
  uniquePieces: bigint;
  sector: bigint;
  minimumCommitmentEpoch: bigint;
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
    expectedMiner: await receiver.expectedMiner() as string,
    calls: await receiver.calls() as bigint,
    uniquePieces: await receiver.uniquePieces() as bigint,
    sector: await receiver.lastSector() as bigint,
    minimumCommitmentEpoch: await receiver.lastMinimumCommitmentEpoch() as bigint,
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

function dealContext(context: ScenarioContext, pieceSize: bigint): ScenarioContext {
  return {
    ...context,
    config: {
      ...context.config,
      env: {
        ...context.config.env,
        V2_PRICE_PER_32GIB_MONTH: "1000000",
        V2_REQUESTED_SIZE_BYTES: pieceSize.toString(),
        V2_RETRIEVABILITY_BPS: "9000",
        V2_BANDWIDTH_BYTES_PER_SECOND: "1048576",
        V2_LATENCY_MS: "1000",
        V2_INDEXING_PCT: "100",
      },
    },
  };
}
