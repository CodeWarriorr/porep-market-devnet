import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AbiCoder } from "ethers";
import { assertEqual } from "../assertions.js";
import { artifactAbis } from "../contracts/abi.js";
import { Evm, firstUint, lower } from "../contracts/evm.js";
import { contracts, type EvidenceStatus } from "../contracts/views.js";
import { readCurioCommitBatchMetrics, readCurioCommitMessageMetrics, submitCurioSectorEvidenceDeal, waitForCurioSectors } from "../devnet/curio.js";
import { applySectorEvidenceCommitBatchConfig, type CurioCommitBatchLease } from "../devnet/curioCommitBatch.js";
import { generatePieceAndAssertCommp } from "../devnet/piece.js";
import { buildSectorEvidencePieceSet } from "../fixtures/sectorEvidencePieceSet.js";
import { proposeDealAndAssertAccepted } from "../flows/deal.js";
import { registerDevnetProviderAndOffer } from "../flows/provider.js";
import { createPreparedRailAndAssertRate, createValidatorForDeal, depositAndApproveValidatorOperator } from "../flows/validatorRail.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import { dockerExec } from "../devnet/docker.js";
import { activateEvidenceAndAssertDealActive, expectDoubleActivationToFail } from "../flows/evidence.js";
import { configureSettlementCadenceForDevnet, expectSettlementBlockedWithoutPayout, setSliAttestationForDeal, settleRailAndAssertProviderPayout, waitForSettlementWindow } from "../flows/settlement.js";
import { validateSectorStatus } from "./sectorStatus.js";
import { readSectorExpiration, readSectorLocation } from "../fixtures/activeSector.js";

type Receipt = { providerActorId: bigint; pieceCount: bigint; acceptedPieceCount: bigint; activated: boolean; minimumCommitmentEpoch: bigint; acceptedBytes: bigint };
type PiecePlacement = { pieceCidDigest: string; sectorNumber: bigint; paddedSize: bigint; minimumCommitmentEpoch: bigint; accepted: boolean };
type RefreshState = { nextSectorIndex: bigint; pendingCoveredBytes: bigint; sweepStartEpoch: bigint; pendingMinimumExpiration: bigint; lastCompletedEpoch: bigint; completedExpiration: bigint; completedResult: bigint };
type SectorObservation = { sectorNumber: bigint; coveredBytes: bigint; deadline: bigint; partition: bigint; expiration: bigint; active: boolean };
export type SectorEvidenceRefreshScenarioOptions = {
  pieceCount: number;
  artifactFileName: string;
  batchCurioCommit?: boolean;
  rawPieceSizeBytes?: number;
};

export async function runSectorEvidenceMultiPieceActivation(context: ScenarioContext): Promise<void> {
  await runSectorEvidenceRefresh(context, {
    pieceCount: 3,
    artifactFileName: "curio-sector-evidence-manifest.json",
  });
}

export async function runSectorEvidenceRefresh(
  context: ScenarioContext,
  options: SectorEvidenceRefreshScenarioOptions,
): Promise<void> {
  const evm = new Evm(context);
  const abis = artifactAbis(context);
  const market = evm.contract(context.config.addresses.poRepMarket, abis.poRepMarket);
  const adapter = evm.contract(context.config.addresses.sectorEvidenceAdapter, abis.sectorEvidenceAdapter);
  if (!adapter.interface.hasFunction("getRefreshState(uint256)")) {
    throw new Error("deployed SectorEvidenceAdapter ABI does not contain the refresh implementation");
  }
  const target = { mode: context.config.deploymentTargetMode, commit: context.config.deploymentPorepCommit, dirty: context.config.deploymentTargetDirty, revision: context.config.deploymentRevision };
  const original = context.config.addresses.dataCapEvidenceAdapter;
  const journal = switchJournal(context, original);
  await recoverSwitchJournal(context, market, journal);
  assertEqual(lower(await market.getGlobalEvidenceAdapter() as string), lower(original), "original global DataCap adapter");
  const pieces = await runStep(
    context,
    `generate ${options.pieceCount} distinct sector-evidence pieces`,
    () => Array.from(
      { length: options.pieceCount },
      () => generatePieceAndAssertCommp(context, options.rawPieceSizeBytes),
    ),
  );
  const commitment = buildSectorEvidencePieceSet(pieces.map((piece) => ({ pieceCidDigest: `0x${piece.pieceCidHex.slice(-64)}`, paddedSize: piece.pieceSize })));
  const canonicalPieces = commitment.pieces.map((row) => {
    const piece = pieces.find((candidate) => `0x${candidate.pieceCidHex.slice(-64)}`.toLowerCase() === row.pieceCidDigest && candidate.pieceSize === row.paddedSize);
    if (!piece) throw new Error(`generated piece is missing canonical commitment row ${row.pieceCidDigest}/${row.paddedSize}`);
    return { row, piece };
  });
  const scenarioContext: ScenarioContext = { ...context, config: { ...context.config, env: { ...context.config.env, V2_REQUESTED_SIZE_BYTES: commitment.requestedSizeBytes.toString(), V2_PRICE_PER_32GIB_MONTH: "999999", V2_RETRIEVABILITY_BPS: "0", V2_BANDWIDTH_BYTES_PER_SECOND: "0", V2_LATENCY_MS: "0", V2_INDEXING_PCT: "0" } } };
  const artifacts: Record<string, unknown> = {
    target,
    requestedSectorCount: options.pieceCount,
    commitment,
    originalGlobalAdapter: original,
    switchJournal: switchJournalPath(context),
    pieces,
  };
  let switchTx = "";
  let restoreTx = "";
  let globalAdapterNeedsRestore = false;
  let commitBatchLease: CurioCommitBatchLease | undefined;
  try {
    await runStep(context, "prove Curio notification-success configuration", () => assertCurioNotificationSuccess(context));
    const offer = await runStep(context, "register provider and offer", () => registerDevnetProviderAndOffer(scenarioContext));
    switchTx = await runStep(context, "select Sector evidence adapter", async () => {
      writeSwitchJournal(context, journal);
      const tx = await evm.sendWithPrivateKey(context.config.identityKeys.deployer, context.config.addresses.poRepMarket, "setGlobalEvidenceAdapter(address)", [context.config.addresses.sectorEvidenceAdapter]);
      globalAdapterNeedsRestore = true;
      assertEqual(lower(await market.getGlobalEvidenceAdapter() as string), lower(context.config.addresses.sectorEvidenceAdapter), "selected Sector adapter");
      return tx;
    });
    const deal = await runStep(context, `propose ${options.pieceCount}-piece Sector evidence deal`, () => proposeDealAndAssertAccepted(scenarioContext, offer, commitment.manifestHash, context.config.addresses.sectorEvidenceAdapter));
    restoreTx = await runStep(context, "restore global DataCap adapter", async () => {
      const tx = await evm.sendWithPrivateKey(context.config.identityKeys.deployer, context.config.addresses.poRepMarket, "setGlobalEvidenceAdapter(address)", [original]);
      assertEqual(lower(await market.getGlobalEvidenceAdapter() as string), lower(original), "restored global adapter");
      globalAdapterNeedsRestore = false;
      writeSwitchJournal(context, { ...journal, status: "restored", restoreTx: tx });
      return tx;
    });
    const validator = await runStep(context, "create validator", () => createValidatorForDeal(scenarioContext, deal));
    await runStep(context, "deposit and approve validator", () => depositAndApproveValidatorOperator(scenarioContext, deal, validator));
    const rail = await runStep(context, "create prepared rail", () => createPreparedRailAndAssertRate(scenarioContext, deal, validator));
    await runStep(context, "configure one-epoch settlement cadence", () => configureSettlementCadenceForDevnet(context, deal));
    const expectedPieceCount = BigInt(commitment.pieces.length);
    await runStep(context, `assert activation rejected at 0/${options.pieceCount}`, async () => assertProgress(context, adapter, deal.dealId, 0n, 0n, commitment.requestedSizeBytes, expectedPieceCount));
    const curioDeals: Awaited<ReturnType<typeof submitCurioSectorEvidenceDeal>>[] = [];
    const pipelines = new Map<string, { sector: number | null }>();
    if (options.batchCurioCommit) {
      commitBatchLease = await runStep(context, `apply temporary ${options.pieceCount}-sector Curio commit batch`, () =>
        applySectorEvidenceCommitBatchConfig(context, options.pieceCount));
      for (let pieceIndex = 0; pieceIndex < canonicalPieces.length; pieceIndex++) {
        const canonical = canonicalPieces[pieceIndex]!;
        assertEqual(canonical.piece.pieceSize, 8_388_608n, `piece ${pieceIndex} fills one 8 MiB sector`);
        curioDeals.push(await runStep(context, `submit sector-evidence piece ${pieceIndex + 1}/${canonicalPieces.length}`, () =>
          submitCurioSectorEvidenceDeal(context, canonical.piece, deal.dealId, pieceIndex, canonicalPieces.length, commitment.proofs[pieceIndex]!)));
      }
      const completed = await runStep(context, `wait for one ${options.pieceCount}-sector Curio commit`, () =>
        waitForCurioSectors(context, curioDeals.map((item) => item.dealId)));
      for (const [id, pipeline] of completed) pipelines.set(id, pipeline);
      await runStep(context, `assert receipt at ${options.pieceCount}/${options.pieceCount}`, async () => {
        await assertProgress(context, adapter, deal.dealId, expectedPieceCount, commitment.requestedSizeBytes, commitment.requestedSizeBytes, expectedPieceCount);
        for (let index = 0; index < canonicalPieces.length; index++) {
          assert.equal(await adapter.isPieceAccepted(deal.dealId, index), true);
        }
      });
    } else {
      let acceptedBytes = 0n;
      for (let pieceIndex = 0; pieceIndex < canonicalPieces.length; pieceIndex++) {
        const canonical = canonicalPieces[pieceIndex]!;
        const curioDeal = await runStep(context, `submit sector-evidence piece ${pieceIndex + 1}/${canonicalPieces.length}`, () =>
          submitCurioSectorEvidenceDeal(context, canonical.piece, deal.dealId, pieceIndex, canonicalPieces.length, commitment.proofs[pieceIndex]!)
        );
        curioDeals.push(curioDeal);
        const completed = await runStep(context, `wait for Curio callback ${pieceIndex + 1}/${canonicalPieces.length}`, () => waitForCurioSectors(context, [curioDeal.dealId]));
        for (const [id, pipeline] of completed) pipelines.set(id, pipeline);
        acceptedBytes += canonical.piece.pieceSize;
        await runStep(context, `assert receipt at ${pieceIndex + 1}/${canonicalPieces.length}`, async () => {
          await assertProgress(context, adapter, deal.dealId, BigInt(pieceIndex + 1), acceptedBytes, commitment.requestedSizeBytes, expectedPieceCount);
          for (let index = 0; index < canonicalPieces.length; index++) {
            assert.equal(await adapter.isPieceAccepted(deal.dealId, index), index <= pieceIndex);
          }
        });
      }
    }
    const inventory = await runStep(context, "verify on-chain piece and sector inventory", () => readAndAssertInventory(adapter, deal.dealId, BigInt(context.config.provider.slice(2)), canonicalPieces, curioDeals, pipelines, commitment.requestedSizeBytes));
    artifacts.inventory = inventory;
    artifacts.curioCommitMessages = inventory.sectorNumbers.map((sectorNumber) => ({
      sectorNumber,
      ...readCurioCommitMessageMetrics(context, Number(sectorNumber)),
    }));
    if (options.batchCurioCommit) {
      artifacts.curioCommitBatch = readCurioCommitBatchMetrics(
        context,
        inventory.sectorNumbers.map(Number),
      );
      await runStep(context, "restore normal Curio commit batching", () => commitBatchLease!.restore());
      commitBatchLease = undefined;
    }
    artifacts.callbackGasBreakdown = {
      available: false,
      reason: "Curio stores the whole prove-commit receipt gas, but does not expose gas immediately before and after the receiver callback",
    };
    const active = await runStep(context, "activate exact completed receipt", async () => {
      const activated = await activateEvidenceAndAssertDealActive(scenarioContext, deal, rail);
      const receipt = await adapter.getManifestReceipt(deal.dealId) as unknown as Receipt;
      assert.equal(receipt.activated, true);
      return activated;
    });
    await runStep(context, "prove double activation is rejected", () => expectDoubleActivationToFail(context, active));
    const sectorObservations = await runStep(context, "record FIP-0112 liveness and expiration observations", async () =>
      await Promise.all(inventory.sectorNumbers.map(async (sectorNumber) => {
        const sector = Number(sectorNumber);
        const location = await readSectorLocation(context, sector);
        return {
          sectorNumber,
          coveredBytes: firstUint(await adapter.getSectorCoveredBytes(deal.dealId, sectorNumber)),
          deadline: BigInt(location.Deadline),
          partition: BigInt(location.Partition),
          expiration: await readSectorExpiration(context, sector),
          active: await validateSectorStatus(context, deal.dealId, sector, 1, location.Deadline, location.Partition),
        } satisfies SectorObservation;
      }))
    );
    assert.equal(sectorObservations.every((observation) => observation.active), true);
    artifacts.sectorObservations = sectorObservations;
    artifacts.sliAttestation = await runStep(context, "set SLI attestation before settlement", () =>
      setSliAttestationForDeal(scenarioContext, deal)
    );
    const initialStatus = await runStep(context, "assert settlement evidence starts inactive", async () => {
      const status = await contracts(context).evidenceStatus(deal.dealId);
      assertEqual(status.activeCoveredBytes, 0n, "initial evidence covered bytes");
      assertEqual(status.lastEvidenceRefreshEpoch, 0n, "initial evidence refresh epoch");
      assertEqual(status.result, 50n, "initial evidence INACTIVE result");
      assertEqual(status.checkedClaims, 0n, "initial checked sectors");
      assertEqual(status.totalClaims, BigInt(sectorObservations.length), "initial total sectors");
      return status;
    });
    const heldSettlement = await runStep(context, "prove inactive evidence holds the settlement cursor", async () => {
      const view = contracts(context);
      const railBefore = await view.rail(rail.railId);
      const serviceBefore = await view.dealService(deal.dealId);
      const window = await waitForSettlementWindow(context, deal, rail);
      await expectSettlementBlockedWithoutPayout(context, deal.dealId, rail, window.readyEpoch, "EvidenceTooStale");
      const railAfter = await view.rail(rail.railId);
      const serviceAfter = await view.dealService(deal.dealId);
      assertEqual(railAfter.settledUpTo, railBefore.settledUpTo, "held FilecoinPay cursor");
      assertEqual(serviceAfter.lastSettledEpoch, serviceBefore.lastSettledEpoch, "held PoRep Market cursor");
      return { targetEpoch: window.readyEpoch, filecoinPayCursor: railBefore.settledUpTo, marketCursor: serviceBefore.lastSettledEpoch, filecoinPayError: "EvidenceTooStale", evidenceResult: "INACTIVE" };
    });
    artifacts.initialEvidenceStatus = initialStatus;
    artifacts.heldSettlement = heldSettlement;

    const firstRefresh = await runStep(context, "refresh one sector without publishing ACTIVE", async () => {
      const evidenceData = encodeLocations(sectorObservations.slice(0, 1));
      const preview = refreshStatus(await market.refreshEvidenceStatus.staticCall(deal.dealId, evidenceData, {
        from: context.config.identityAddresses.porepService,
      }));
      assertEqual(preview.result, 10n, "one-sector refresh preview PARTIAL");
      assertEqual(preview.activeCoveredBytes, sectorObservations[0]!.coveredBytes, "one-sector preview covered bytes");
      assertEqual(preview.checkedClaims, 1n, "one-sector preview cursor");
      assertEqual(preview.totalClaims, BigInt(sectorObservations.length), "one-sector preview total");
      const txHash = await evm.sendWithPrivateKey(context.config.identityKeys.porepService, context.config.addresses.poRepMarket, "refreshEvidenceStatus(uint256,bytes)", [deal.dealId, evidenceData]);
      const transaction = await transactionMetrics(evm, txHash);
      const persisted = await contracts(context).evidenceStatus(deal.dealId);
      assertCompletedStatusUnchanged(initialStatus, persisted);
      const state = await adapter.getRefreshState(deal.dealId) as unknown as RefreshState;
      assertEqual(state.nextSectorIndex, 1n, "stored refresh cursor");
      assertEqual(state.pendingCoveredBytes, sectorObservations[0]!.coveredBytes, "stored pending covered bytes");
      assertEqual(state.pendingMinimumExpiration, sectorObservations[0]!.expiration, "stored pending expiration");
      assertEqual(state.sweepStartEpoch, transaction.blockNumber, "stored sweep start epoch");
      return { evidenceData, preview, persisted, state, transaction };
    });
    artifacts.oneSectorRefresh = firstRefresh;

    const finalRefresh = await runStep(context, "complete refresh with a multi-sector batch", async () => {
      const remaining = sectorObservations.slice(1);
      assert.equal(remaining.length >= 2, true, "final refresh batch contains multiple sectors");
      const evidenceData = encodeLocations(remaining);
      const preview = refreshStatus(await market.refreshEvidenceStatus.staticCall(deal.dealId, evidenceData, {
        from: context.config.identityAddresses.porepService,
      }));
      const minimumExpiration = sectorObservations.reduce((minimum, observation) => observation.expiration < minimum ? observation.expiration : minimum, sectorObservations[0]!.expiration);
      assertEqual(preview.result, 40n, "final refresh preview ACTIVE");
      assertEqual(preview.activeCoveredBytes, commitment.requestedSizeBytes, "final refresh preview covered bytes");
      assertEqual(preview.checkedClaims, BigInt(sectorObservations.length), "final refresh preview checked sectors");
      assertEqual(preview.totalClaims, BigInt(sectorObservations.length), "final refresh preview total sectors");
      const txHash = await evm.sendWithPrivateKey(context.config.identityKeys.porepService, context.config.addresses.poRepMarket, "refreshEvidenceStatus(uint256,bytes)", [deal.dealId, evidenceData]);
      const transaction = await transactionMetrics(evm, txHash);
      const persisted = await contracts(context).evidenceStatus(deal.dealId);
      assertEqual(persisted.result, 40n, "completed evidence ACTIVE");
      assertEqual(persisted.activeCoveredBytes, commitment.requestedSizeBytes, "completed active covered bytes");
      assertEqual(persisted.lastEvidenceRefreshEpoch, firstRefresh.transaction.blockNumber, "completed sweep freshness epoch");
      assertEqual(persisted.checkedClaims, BigInt(sectorObservations.length), "completed checked sectors");
      const state = await adapter.getRefreshState(deal.dealId) as unknown as RefreshState;
      assertEqual(state.nextSectorIndex, 0n, "completed cursor reset");
      assertEqual(state.pendingCoveredBytes, 0n, "completed pending bytes reset");
      assertEqual(state.sweepStartEpoch, 0n, "completed sweep start reset");
      assertEqual(state.pendingMinimumExpiration, 0n, "completed pending expiration reset");
      assertEqual(state.lastCompletedEpoch, firstRefresh.transaction.blockNumber, "completed refresh epoch");
      assertEqual(state.completedExpiration, minimumExpiration, "completed minimum expiration");
      assertEqual(state.completedResult, 40n, "completed refresh result");
      assertEqual(firstUint(await adapter.getExpiration(deal.dealId)), minimumExpiration, "adapter expiration");
      return { evidenceData, preview, persisted, state, transaction };
    });
    artifacts.multiSectorRefresh = finalRefresh;

    const settlement = await runStep(context, "settle the full held interval after ACTIVE refresh", () => settleRailAndAssertProviderPayout(scenarioContext, deal, active, rail));
    assertEqual(settlement.fromEpoch, heldSettlement.filecoinPayCursor, "catch-up settlement starts at held cursor");
    assert.equal(settlement.expectedGross > 0n, true, "catch-up gross payment is positive");
    assert.equal(settlement.paidAmount > 0n, true, "catch-up provider payment is positive");
    artifacts.settlement = settlement;
    artifacts.curioDeals = curioDeals.map((item) => ({ ...item, pipeline: pipelines.get(item.dealId) }));
    artifacts.dealId = deal.dealId.toString(); artifacts.railId = rail.railId.toString(); artifacts.switchTx = switchTx;
  } finally {
    if (globalAdapterNeedsRestore) {
      restoreTx = await evm.sendWithPrivateKey(context.config.identityKeys.deployer, context.config.addresses.poRepMarket, "setGlobalEvidenceAdapter(address)", [original]);
      globalAdapterNeedsRestore = false;
      writeSwitchJournal(context, { ...journal, status: "restored", restoreTx });
    }
    if (commitBatchLease) {
      await commitBatchLease.restore();
      commitBatchLease = undefined;
    }
    assertEqual(lower(await market.getGlobalEvidenceAdapter() as string), lower(original), "restored global adapter");
    artifacts.restoreTx = restoreTx;
    writeFileSync(join(context.runDir, options.artifactFileName), `${JSON.stringify(artifacts, bigintJson, 2)}\n`);
  }
}

type SwitchJournal = { generation: string; deploymentId: string; revision: number; poRepMarket: string; originalAdapter: string; targetAdapter: string; status: "pending" | "restored"; restoreTx?: string };
function switchJournal(context: ScenarioContext, originalAdapter: string): SwitchJournal { return { generation: context.config.generation, deploymentId: context.config.deploymentId, revision: context.config.deploymentRevision, poRepMarket: context.config.addresses.poRepMarket, originalAdapter, targetAdapter: context.config.addresses.sectorEvidenceAdapter, status: "pending" }; }
function switchJournalPath(context: ScenarioContext): string { return join(context.projectRoot, ".runtime", "sector-evidence-adapter-switch.json"); }
function writeSwitchJournal(context: ScenarioContext, record: SwitchJournal): void { const path = switchJournalPath(context); mkdirSync(join(path, ".."), { recursive: true }); const temporary = `${path}.temporary.${process.pid}`; writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`); renameSync(temporary, path); }
export async function recoverSwitchJournal(context: ScenarioContext, market: any, expected: SwitchJournal): Promise<void> { let record: SwitchJournal; try { record = JSON.parse(readFileSync(switchJournalPath(context), "utf8")) as SwitchJournal; } catch { return; } if (record.status === "restored") return; if (record.generation !== expected.generation || record.deploymentId !== expected.deploymentId || record.revision !== expected.revision || lower(record.poRepMarket) !== lower(expected.poRepMarket) || lower(record.originalAdapter) !== lower(expected.originalAdapter) || lower(record.targetAdapter) !== lower(expected.targetAdapter)) throw new Error("sector adapter switch journal identity mismatch"); const live = await market.getGlobalEvidenceAdapter() as string; if (lower(live) === lower(record.originalAdapter)) { writeSwitchJournal(context, { ...record, status: "restored" }); return; } if (lower(live) !== lower(record.targetAdapter)) throw new Error(`sector adapter switch journal found unexpected live adapter ${live}`); const tx = await new Evm(context).sendWithPrivateKey(context.config.identityKeys.deployer, record.poRepMarket, "setGlobalEvidenceAdapter(address)", [record.originalAdapter]); if (lower(await market.getGlobalEvidenceAdapter() as string) !== lower(record.originalAdapter)) throw new Error("sector adapter switch recovery did not restore DataCap adapter"); writeSwitchJournal(context, { ...record, status: "restored", restoreTx: tx }); }

function assertCurioNotificationSuccess(context: ScenarioContext): void {
  const output = dockerExec(context, "curio", ["curio", "config", "interpret", "--layers", "seal,post,market,gui"]);
  if (!/RequireNotificationSuccess\s*=\s*true/i.test(output)) throw new Error("Curio effective RequireNotificationSuccess is not true");
  if (!/Seal|SubmitCommit|Snap/i.test(output)) throw new Error("Curio interpretation did not expose seal/snap task configuration");
}

async function assertProgress(
  context: ScenarioContext,
  adapter: any,
  dealId: bigint,
  count: bigint,
  bytes: bigint,
  requested: bigint,
  expectedPieceCount: bigint,
): Promise<void> {
  const receipt = await adapter.getManifestReceipt(dealId) as unknown as Receipt;
  assertEqual(receipt.acceptedPieceCount, count, "accepted piece count");
  assertEqual(receipt.acceptedBytes, bytes, "accepted bytes");
  assertEqual(receipt.pieceCount, count === 0n ? 0n : expectedPieceCount, "receipt piece count");
  if (count < expectedPieceCount) {
    const evm = new Evm(context);
    await evm.sendWithPrivateKey(context.config.identityKeys.porepService, context.config.addresses.poRepMarket, "activateEvidence(uint256,bytes)", [dealId, "0x"]);
    assertEqual((await contracts(context).dealCapacity(dealId)).committedBytes, 0n, "committed bytes before complete receipt");
    assertEqual((await contracts(context).deal(dealId)).state, 20n, "deal remains ACCEPTED before complete receipt");
  }
  assertEqual(requested >= bytes, true, "accepted bytes do not exceed requested size");
}

async function readAndAssertInventory(
  adapter: any,
  dealId: bigint,
  providerActorId: bigint,
  canonicalPieces: Array<{ row: { pieceCidDigest: string; paddedSize: bigint }; piece: { pieceSize: bigint } }>,
  curioDeals: Array<{ dealId: string }>,
  pipelines: Map<string, { sector: number | null }>,
  requestedSizeBytes: bigint,
): Promise<{
  receipt: Receipt;
  placements: PiecePlacement[];
  sectorCount: bigint;
  sectorNumbers: bigint[];
  coveredBytesBySector: Array<{ sectorNumber: bigint; coveredBytes: bigint }>;
}> {
  const receipt = await adapter.getManifestReceipt(dealId) as unknown as Receipt;
  assertEqual(receipt.providerActorId, providerActorId, "receipt provider actor ID");
  assertEqual(receipt.pieceCount, BigInt(canonicalPieces.length), "receipt piece count");
  assertEqual(receipt.acceptedPieceCount, BigInt(canonicalPieces.length), "receipt accepted piece count");
  assertEqual(receipt.acceptedBytes, requestedSizeBytes, "receipt accepted bytes");
  assert.equal(receipt.activated, false);

  const expectedCoveredBytes = new Map<bigint, bigint>();
  const placements: PiecePlacement[] = [];
  let minimumCommitmentEpoch = 0n;
  for (let pieceIndex = 0; pieceIndex < canonicalPieces.length; pieceIndex++) {
    const canonical = canonicalPieces[pieceIndex]!;
    const pipeline = pipelines.get(curioDeals[pieceIndex]!.dealId);
    if (pipeline?.sector === null || pipeline?.sector === undefined) {
      throw new Error(`Curio sector missing for piece ${pieceIndex}`);
    }
    const placement = await adapter.getPiecePlacement(dealId, pieceIndex) as unknown as PiecePlacement;
    assert.equal(placement.pieceCidDigest.toLowerCase(), canonical.row.pieceCidDigest.toLowerCase());
    assertEqual(placement.sectorNumber, BigInt(pipeline.sector), `piece ${pieceIndex} sector`);
    assertEqual(placement.paddedSize, canonical.row.paddedSize, `piece ${pieceIndex} padded size`);
    assert.equal(placement.minimumCommitmentEpoch > 0n, true, `piece ${pieceIndex} minimum commitment epoch`);
    assert.equal(placement.accepted, true, `piece ${pieceIndex} accepted`);
    placements.push(placement);
    minimumCommitmentEpoch = minimumCommitmentEpoch === 0n || placement.minimumCommitmentEpoch < minimumCommitmentEpoch
      ? placement.minimumCommitmentEpoch
      : minimumCommitmentEpoch;
    expectedCoveredBytes.set(
      placement.sectorNumber,
      (expectedCoveredBytes.get(placement.sectorNumber) ?? 0n) + canonical.piece.pieceSize,
    );
  }
  assertEqual(receipt.minimumCommitmentEpoch, minimumCommitmentEpoch, "receipt minimum commitment epoch");

  const sectorCount = firstUint(await adapter.getSectorCount(dealId));
  assertEqual(sectorCount, BigInt(expectedCoveredBytes.size), "unique sector count");
  assertEqual(sectorCount, BigInt(canonicalPieces.length), "one unique sector per submitted piece");
  assert.equal(sectorCount >= 3n, true, "scenario produced sectors for one-sector and multi-sector refresh batches");
  const sectorNumbers: bigint[] = [];
  const coveredBytesBySector: Array<{ sectorNumber: bigint; coveredBytes: bigint }> = [];
  for (let sectorIndex = 0n; sectorIndex < sectorCount; sectorIndex++) {
    const sectorNumber = firstUint(await adapter.getSectorNumber(dealId, sectorIndex));
    const coveredBytes = firstUint(await adapter.getSectorCoveredBytes(dealId, sectorNumber));
    assertEqual(coveredBytes, expectedCoveredBytes.get(sectorNumber) ?? 0n, `sector ${sectorNumber} covered bytes`);
    sectorNumbers.push(sectorNumber);
    coveredBytesBySector.push({ sectorNumber, coveredBytes });
  }
  assert.equal(new Set(sectorNumbers.map(String)).size, sectorNumbers.length, "sector inventory contains no duplicates");
  return { receipt, placements, sectorCount, sectorNumbers, coveredBytesBySector };
}

function encodeLocations(observations: SectorObservation[]): string {
  return AbiCoder.defaultAbiCoder().encode(
    ["tuple(int64 deadline,int64 partition)[]"],
    [observations.map((observation) => [observation.deadline, observation.partition])],
  );
}

function refreshStatus(value: unknown): EvidenceStatus {
  const result = value as { [index: number]: unknown };
  return {
    activeCoveredBytes: firstUint(result[0]),
    lastEvidenceRefreshEpoch: firstUint(result[1]),
    reasonCode: firstUint(result[2]),
    result: firstUint(result[3]),
    checkedClaims: firstUint(result[4]),
    totalClaims: firstUint(result[5]),
  };
}

function assertCompletedStatusUnchanged(expected: EvidenceStatus, actual: EvidenceStatus): void {
  assertEqual(actual.activeCoveredBytes, expected.activeCoveredBytes, "partial refresh completed covered bytes");
  assertEqual(actual.lastEvidenceRefreshEpoch, expected.lastEvidenceRefreshEpoch, "partial refresh completed epoch");
  assertEqual(actual.reasonCode, expected.reasonCode, "partial refresh completed reason");
  assertEqual(actual.result, expected.result, "partial refresh completed result");
  assertEqual(actual.checkedClaims, expected.checkedClaims, "partial refresh public checked sectors");
  assertEqual(actual.totalClaims, expected.totalClaims, "partial refresh public total sectors");
}

async function transactionMetrics(evm: Evm, txHash: string): Promise<{
  txHash: string;
  calldataBytes: bigint;
  gasUsed: bigint;
  blockNumber: bigint;
}> {
  const [transaction, receipt] = await Promise.all([
    evm.provider.getTransaction(txHash),
    evm.provider.getTransactionReceipt(txHash),
  ]);
  if (!transaction || !receipt) throw new Error(`transaction metrics missing for ${txHash}`);
  return {
    txHash,
    calldataBytes: BigInt((transaction.data.length - 2) / 2),
    gasUsed: receipt.gasUsed,
    blockNumber: BigInt(receipt.blockNumber),
  };
}

function bigintJson(_key: string, value: unknown): unknown { return typeof value === "bigint" ? value.toString() : value; }
