import assert from "node:assert/strict";
import { assertEqual } from "../assertions.js";
import { artifactAbis } from "../contracts/abi.js";
import { firstUint } from "../contracts/evm.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
import { contracts } from "../contracts/views.js";
import { dockerExec } from "../devnet/docker.js";
import { expectSettlementBlockedWithoutPayout, waitForSettlementWindow } from "../flows/settlement.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import { sleep } from "../shell.js";
import { validateSectorStatus } from "./sectorStatus.js";
import {
  encodeLocations,
  refreshStatus,
  runSectorEvidenceRefresh,
  transactionMetrics,
  type SectorObservation,
  type SectorEvidenceSettledRun,
} from "./sectorEvidenceMultiPieceActivation.js";

const SECTOR_STATUS_DEAD = 0;
const EVIDENCE_INACTIVE = 50n;

export async function runSectorEvidenceSectorLoss(context: ScenarioContext): Promise<void> {
  await runSectorEvidenceRefresh(context, {
    pieceCount: 6,
    piecesPerSector: 2,
    rawPieceSizeBytes: 3_000_000,
    artifactFileName: "curio-sector-evidence-sector-loss.json",
    afterSettlement: proveSectorLossStopsPayment,
  });
}

async function proveSectorLossStopsPayment(run: SectorEvidenceSettledRun): Promise<unknown> {
  const { context, evm, market, adapter, deal, rail, sectorObservations } = run;
  const view = contracts(context);

  const wrongWitness = await runStep(context, "reject a refresh with a wrong sector location", async () => {
    const observation = sectorObservations[0]!;
    const statusBefore = await view.evidenceStatus(deal.dealId);
    const stateBefore = Array.from(await adapter.getRefreshState(deal.dealId));
    const error = await expectRevertOnSend(
      evm,
      context.config.identityKeys.porepService,
      context.config.addresses.poRepMarket,
      "refreshEvidenceStatus(uint256,bytes)",
      [deal.dealId, encodeLocations([{ ...observation, partition: observation.partition + 1n }])],
      artifactAbis(context).sectorEvidenceAdapter,
      "SectorStatusUnavailable",
    );
    assertEqual(error.args[0], observation.sectorNumber, "unavailable sector number");
    assert.deepEqual(await view.evidenceStatus(deal.dealId), statusBefore, "wrong witness leaves evidence status unchanged");
    assert.deepEqual(Array.from(await adapter.getRefreshState(deal.dealId)), stateBefore, "wrong witness leaves refresh state unchanged");
    return { sectorNumber: observation.sectorNumber, error: error.name };
  });

  // The middle sector proves the sweep checks earlier active sectors before it reaches the dead one.
  const lost = sectorObservations[1]!;
  const termination = await runStep(context, `terminate sector ${lost.sectorNumber} on chain`, async () => {
    const output = await terminateSectorAndWaitDead(context, deal.dealId, lost);
    return { sectorNumber: lost.sectorNumber, output };
  });

  const inactive = await runStep(context, "refresh publishes INACTIVE for the terminated sector", async () => {
    const evidenceData = encodeLocations(sectorObservations);
    const preview = refreshStatus(await market.refreshEvidenceStatus.staticCall(deal.dealId, evidenceData, {
      from: context.config.identityAddresses.porepService,
    }));
    assertEqual(preview.result, EVIDENCE_INACTIVE, "refresh preview INACTIVE");
    assertEqual(preview.activeCoveredBytes, 0n, "refresh preview covered bytes");
    assertEqual(preview.reasonCode, 0n, "refresh preview reason code");
    assertEqual(preview.checkedClaims, BigInt(sectorObservations.length), "refresh preview checked sectors");
    assertEqual(preview.totalClaims, BigInt(sectorObservations.length), "refresh preview total sectors");
    const txHash = await evm.sendWithPrivateKey(context.config.identityKeys.porepService, context.config.addresses.poRepMarket, "refreshEvidenceStatus(uint256,bytes)", [deal.dealId, evidenceData]);
    const transaction = await transactionMetrics(evm, txHash);
    const persisted = await view.evidenceStatus(deal.dealId);
    assertEqual(persisted.result, EVIDENCE_INACTIVE, "persisted evidence INACTIVE");
    assertEqual(persisted.activeCoveredBytes, 0n, "persisted covered bytes");
    assertEqual(persisted.lastEvidenceRefreshEpoch, transaction.blockNumber, "INACTIVE refresh epoch");
    assertEqual(persisted.reasonCode, 0n, "persisted evidence reason code");
    assertEqual(persisted.checkedClaims, BigInt(sectorObservations.length), "persisted checked sectors");
    assertEqual(persisted.totalClaims, BigInt(sectorObservations.length), "persisted total sectors");
    const state = await adapter.getRefreshState(deal.dealId);
    assertEqual(state.lastCompletedEpoch, transaction.blockNumber, "completed INACTIVE refresh epoch");
    assertEqual(state.completedResult, EVIDENCE_INACTIVE, "completed refresh result");
    assertEqual(state.completedExpiration, 0n, "INACTIVE clears expiration");
    assertEqual(state.nextSectorIndex, 0n, "INACTIVE resets the sweep cursor");
    assertEqual(state.pendingCoveredBytes, 0n, "INACTIVE clears pending covered bytes");
    assertEqual(state.sweepStartEpoch, 0n, "INACTIVE clears sweep start epoch");
    assertEqual(state.pendingMinimumExpiration, 0n, "INACTIVE clears pending expiration");
    assertEqual(firstUint(await adapter.getExpiration(deal.dealId)), 0n, "INACTIVE adapter expiration");
    return { preview, persisted, transaction };
  });

  const held = await runStep(context, "INACTIVE evidence holds the settlement cursor", async () => {
    const railBefore = await view.rail(rail.railId);
    const serviceBefore = await view.dealService(deal.dealId);
    const payerBefore = await view.accountFunds(railBefore.from);
    const window = await waitForSettlementWindow(context, deal, rail);
    await expectSettlementBlockedWithoutPayout(context, deal.dealId, rail, window.readyEpoch, "EvidenceTooStale");
    assertEqual((await view.rail(rail.railId)).settledUpTo, railBefore.settledUpTo, "held FilecoinPay cursor");
    assertEqual((await view.dealService(deal.dealId)).lastSettledEpoch, serviceBefore.lastSettledEpoch, "held PoRep Market cursor");
    assertEqual(await view.accountFunds(railBefore.from), payerBefore, "held payer funds");
    assert.deepEqual(await view.rail(rail.railId), railBefore, "held FilecoinPay rail state");
    assert.deepEqual(await view.dealService(deal.dealId), serviceBefore, "held PoRep Market service state");
    return { targetEpoch: window.readyEpoch, filecoinPayCursor: railBefore.settledUpTo };
  });

  return { wrongWitness, termination, inactive, held };
}

async function terminateSectorAndWaitDead(context: ScenarioContext, dealId: bigint, sector: SectorObservation): Promise<string> {
  let lastError: unknown;
  let output: string | undefined;
  // TerminateSectors rejects sectors in the current and next proving deadline, so retry until one is mutable.
  for (let attempt = 1; attempt <= 30; attempt++) {
    try {
      output = dockerExec(context, "curio", [
        // sptool resolves the terminate subcommand's own --actor flag, which defaults to empty.
        "sptool", "--actor", context.config.provider, "sectors", "terminate",
        "--actor", context.config.provider, "--really-do-it", sector.sectorNumber.toString(),
      ]);
      break;
    } catch (error) {
      if (!String(error).includes("cannot terminate sectors in immutable deadline")) throw error;
      lastError = error;
      await sleep(10_000);
    }
  }
  if (output === undefined) {
    throw new Error(`sector ${sector.sectorNumber} termination did not succeed: ${String(lastError)}`);
  }
  // A terminated sector retains its deadline and partition until the actor removes it.
  for (let poll = 1; poll <= 12; poll++) {
    if (await validateSectorStatus(context, dealId, Number(sector.sectorNumber), SECTOR_STATUS_DEAD, Number(sector.deadline), Number(sector.partition))) return output;
    await sleep(5_000);
  }
  throw new Error(`sector ${sector.sectorNumber} is not dead after termination message\n${output}`);
}
