import { join } from "node:path";
import { assertEqual } from "../assertions.js";
import type { ScenarioContext } from "../runtime.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm } from "../contracts/evm.js";
import { expectCustomError } from "../contracts/reverts.js";
import { contracts } from "../contracts/views.js";
import { generatePieceAndAssertCommp, type PieceInfo } from "../devnet/piece.js";
import { ensureCurioReady, submitCurioOnboarding } from "../devnet/curio.js";
import { waitForProviderClaim } from "../devnet/lotus.js";
import { requireDevnet } from "../devnet/docker.js";
import { runRequired } from "../shell.js";
import type { AcceptedDeal } from "./deal.js";

export type DataCapAllocation = {
  allocationId: bigint;
  allocationIds: bigint[];
  piece: PieceInfo;
};

export type ProviderClaim = {
  claimId: bigint;
  claimIds: bigint[];
};

export type MultipleDataCapAllocations = {
  allocations: DataCapAllocation[];
  allocationIds: bigint[];
  pieces: PieceInfo[];
  totalPieceSize: bigint;
};

export function generatePiece(context: ScenarioContext): PieceInfo {
  requireDevnet(context);
  return generatePieceAndAssertCommp(context);
}

export async function submitDataCapAllocation(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  piece: PieceInfo
): Promise<DataCapAllocation> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const deal = await view.deal(accepted.dealId);
  if (deal.provider === 0n) throw new Error(`V2 deal ${accepted.dealId} has no provider`);

  console.log("=== Submit V2 DataCap batch ===");
  console.log(`  Deal:     ${accepted.dealId}`);
  console.log(`  Provider: ${deal.provider}`);
  console.log(`  Piece:    ${piece.pieceSize} bytes`);
  console.log(`  Adapter:  ${context.config.addresses.dataCapEvidenceAdapter}`);

  const beforeAllocationIds = await view.allocationIds(accepted.dealId);
  const calldata = computeDataCapBatchCalldata(context, {
    provider: deal.provider,
    pieceSize: piece.pieceSize,
    dealId: accepted.dealId,
    pieceCidHex: piece.pieceCidHex
  });
  const txHash = await evm.send(context.config.addresses.dataCapEvidenceAdapter, calldata);
  const allocationIds = await view.allocationIds(accepted.dealId);
  const allocationId = allocationIds.find((id) => !beforeAllocationIds.includes(id));
  if (allocationId === undefined || allocationId <= 0n) {
    throw new Error(`adapter returned no new allocation id; before=${beforeAllocationIds.join(",")} after=${allocationIds.join(",")}`);
  }

  context.state.set("PROVIDER", deal.provider);
  context.state.set("ALLOC_ID", allocationId);
  context.state.set("ALLOC_IDS_CSV", allocationIds.join(","));
  context.state.set("ALLOC_COUNT", allocationIds.length);

  console.log(`  TX: ${txHash}`);
  console.log(`  Allocation IDs: ${allocationIds.join(",")}`);
  console.log("=== V2 DataCap batch submitted ===");
  return { allocationId, allocationIds, piece };
}

export async function submitMultipleDataCapAllocations(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  count = 2
): Promise<MultipleDataCapAllocations> {
  if (count < 2) throw new Error(`multi-claim scenario requires at least 2 allocations, got ${count}`);

  const previousGeneratePiece = context.config.env.GENERATE_PIECE;
  context.config.env.GENERATE_PIECE = "1";
  try {
    const allocations: DataCapAllocation[] = [];
    const pieces: PieceInfo[] = [];

    console.log("=== Submit multiple V2 DataCap allocations ===");
    console.log(`  Deal: ${accepted.dealId}`);
    console.log(`  Allocation count: ${count}`);

    for (let index = 0; index < count; index++) {
      console.log(`  Allocation ${index + 1} / ${count}`);
      const piece = generatePiece(context);
      const allocation = await submitDataCapAllocation(context, accepted, piece);
      allocations.push(allocation);
      pieces.push(piece);
    }

    const allocationIds = allocations.map((allocation) => allocation.allocationId);
    const totalPieceSize = pieces.reduce((sum, piece) => sum + piece.pieceSize, 0n);
    context.state.set("MULTI_ALLOC_IDS_CSV", allocationIds.join(","));
    context.state.set("MULTI_ALLOC_COUNT", allocationIds.length);
    context.state.set("MULTI_ALLOC_TOTAL_PIECE_SIZE", totalPieceSize);
    console.log(`  New allocation IDs: ${allocationIds.join(",")}`);
    console.log(`  Total allocated piece size: ${totalPieceSize}`);
    console.log("=== Multiple V2 DataCap allocations submitted ===");
    return { allocations, allocationIds, pieces, totalPieceSize };
  } finally {
    if (previousGeneratePiece === undefined) {
      delete context.config.env.GENERATE_PIECE;
    } else {
      context.config.env.GENERATE_PIECE = previousGeneratePiece;
    }
  }
}

export async function expectDataCapAllocationWithoutPreparedRailToFail(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  piece: PieceInfo
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const deal = await view.deal(accepted.dealId);
  if (deal.provider === 0n) throw new Error(`V2 deal ${accepted.dealId} has no provider`);
  assertEqual(deal.state, 20n, "no-rail deal state before DataCap allocation");
  assertEqual(deal.railId, 0n, "no-rail deal railId before DataCap allocation");

  console.log("=== Expect V2 DataCap allocation without prepared rail to fail ===");
  console.log(`  Deal:     ${accepted.dealId}`);
  console.log(`  Provider: ${deal.provider}`);
  console.log(`  Piece:    ${piece.pieceSize} bytes`);
  console.log(`  Adapter:  ${context.config.addresses.dataCapEvidenceAdapter}`);
  console.log("  Expected boundary: DataCapEvidenceAdapter rejects deal snapshots with railId=0");

  const calldata = computeDataCapBatchCalldata(context, {
    provider: deal.provider,
    pieceSize: piece.pieceSize,
    dealId: accepted.dealId,
    pieceCidHex: piece.pieceCidHex
  });

  const error = await expectCustomError(
    () => evm.simulate(context.config.addresses.dataCapEvidenceAdapter, calldata),
    artifactAbis(context).dataCapEvidenceAdapter,
    "InvalidRailId"
  );
  console.log(`  DataCap allocation failed with ${error.name}`);

  const afterDeal = await view.deal(accepted.dealId);
  assertEqual(afterDeal.state, 20n, "no-rail deal state after blocked DataCap allocation");
  assertEqual(afterDeal.railId, 0n, "no-rail deal railId after blocked DataCap allocation");
  assertEqual((await view.allocationIds(accepted.dealId)).length, 0, "no-rail allocation ids after blocked DataCap allocation");
  console.log("Expected guard observed for: DataCap allocation without prepared rail");
}

export async function importPieceAndWaitForProviderClaim(
  context: ScenarioContext,
  allocation: DataCapAllocation
): Promise<ProviderClaim> {
  ensureCurioReady(context);
  const importResult = await submitCurioOnboarding(context, {
    allocationId: allocation.allocationId,
    pieceCid: allocation.piece.pieceCid,
    pieceCidV2: allocation.piece.pieceCidV2,
    pieceCarPath: allocation.piece.pieceCarPath
  });
  const claim = await waitForProviderClaim(context, {
    allocationId: allocation.allocationId,
    targetStartEpoch: importResult.startEpoch
  });

  context.state.set("CLAIM_IDS_CSV", claim.claimId);
  context.state.set("CLAIM_COUNT", 1);
  return { claimId: claim.claimId, claimIds: [claim.claimId] };
}

export async function importAllocationsAndWaitForProviderClaims(
  context: ScenarioContext,
  multiple: MultipleDataCapAllocations
): Promise<ProviderClaim> {
  const claimIds: bigint[] = [];

  console.log("=== Import multiple V2 allocations and wait for provider claims ===");
  for (const allocation of multiple.allocations) {
    const claim = await importPieceAndWaitForProviderClaim(context, allocation);
    claimIds.push(claim.claimId);
  }

  context.state.set("MULTI_CLAIM_IDS_CSV", claimIds.join(","));
  context.state.set("CLAIM_IDS_CSV", claimIds.join(","));
  context.state.set("CLAIM_COUNT", claimIds.length);
  console.log(`  Claim IDs: ${claimIds.join(",")}`);
  console.log("=== Multiple V2 provider claims observed ===");
  return { claimId: claimIds[0] ?? 0n, claimIds };
}

export async function finishDataCapPostingAndAssertAllocated(
  context: ScenarioContext,
  accepted: AcceptedDeal
): Promise<{ txHash: string }> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);

  console.log("=== Finish V2 DataCap posting ===");
  const txHash = await evm.send(context.config.addresses.dataCapEvidenceAdapter, "finishDataCapPosting(uint256)", [accepted.dealId]);
  assertEqual(await view.dataCapPostingFinished(accepted.dealId), true, "DataCap posting finished");
  assertEqual(await view.dealAllocationStatus(accepted.dealId), 10n, "allocation status ALLOCATED");

  console.log(`  Posting finished for deal ${accepted.dealId}`);
  console.log("=== V2 DataCap posting closed ===");
  return { txHash };
}

export async function submitEvidenceAllocationBatchesAndAssertClaimCoverage(
  context: ScenarioContext,
  accepted: AcceptedDeal,
  expectedClaimCount: number,
  batchSize = 1n
): Promise<{ txHashes: string[]; claimIds: bigint[] }> {
  requireDevnet(context);
  if (batchSize <= 0n) throw new Error(`evidence allocation batch size must be > 0, got ${batchSize}`);
  const evm = new Evm(context);
  const view = contracts(context);
  const evidenceData = evm.abiEncode("f(uint256)", batchSize);
  const txHashes: string[] = [];

  console.log("=== Submit V2 evidence allocation batches ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Expected claims: ${expectedClaimCount}`);
  console.log(`  Batch size: ${batchSize}`);

  for (let batch = 1; batch <= expectedClaimCount; batch++) {
    const beforeClaims = await view.claimIds(accepted.dealId);
    const txHash = await evm.sendWithPrivateKey(
      context.config.identityKeys.porepService,
      context.config.addresses.poRepMarket,
      "submitEvidenceBatch(uint256,bytes)",
      [accepted.dealId, evidenceData],
    );
    txHashes.push(txHash);

    const afterClaims = await view.claimIds(accepted.dealId);
    if (afterClaims.length <= beforeClaims.length) {
      throw new Error(`evidence batch ${batch} did not add a claim id`);
    }
    console.log(`  Batch ${batch}: tx=${txHash}, claims=${afterClaims.join(",")}`);

    if (afterClaims.length >= expectedClaimCount) break;
  }

  const claimIds = await view.claimIds(accepted.dealId);
  assertEqual(claimIds.length, expectedClaimCount, "claim count after allocation evidence batches");
  assertEqual(await view.dealAllocationStatus(accepted.dealId), 20n, "allocation status CLAIMED after allocation evidence batches");

  context.state.set("EVIDENCE_BATCH_TXS_CSV", txHashes.join(","));
  context.state.set("CLAIM_IDS_CSV", claimIds.join(","));
  context.state.set("CLAIM_COUNT", claimIds.length);
  console.log(`  Final claim IDs: ${claimIds.join(",")}`);
  console.log("=== V2 evidence allocation batches submitted ===");
  return { txHashes, claimIds };
}

function computeDataCapBatchCalldata(
  context: ScenarioContext,
  input: { provider: bigint; pieceSize: bigint; dealId: bigint; pieceCidHex: string }
): string {
  const output = runRequired(
    "forge",
    ["script", join(context.projectRoot, "contracts/script/ComputeDataCapBatchCalldata.s.sol"), "--rpc-url", context.config.rpcUrl],
    context.config.porepSourceDir,
    {
      PROVIDER: input.provider.toString(),
      PIECE_SIZE: input.pieceSize.toString(),
      DEAL_ID: input.dealId.toString(),
      PIECE_CID_HEX: input.pieceCidHex
    }
  );
  const calldata = output.match(/CALLDATA=(0x[0-9a-fA-F]+)/)?.[1];
  if (!calldata) throw new Error(`failed to compute submitDataCapBatch calldata\n${output}`);
  return calldata;
}
