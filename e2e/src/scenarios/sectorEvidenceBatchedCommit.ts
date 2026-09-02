import type { ScenarioContext } from "../runtime.js";
import { runSectorEvidenceRefresh } from "./sectorEvidenceMultiPieceActivation.js";

const DEFAULT_BATCHED_COMMIT_SECTOR_COUNT = 4;

export function batchedCommitSectorCount(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_BATCHED_COMMIT_SECTOR_COUNT;
  if (!/^[0-9]+$/.test(raw)) throw invalidSectorCount();
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 4) throw invalidSectorCount();
  return count;
}

export async function runSectorEvidenceBatchedCommit(
  context: ScenarioContext,
): Promise<void> {
  const pieceCount = batchedCommitSectorCount(
    context.config.env.SECTOR_EVIDENCE_BATCHED_COMMIT_SECTOR_COUNT,
  );
  await runSectorEvidenceRefresh(context, {
    pieceCount,
    artifactFileName: `curio-sector-evidence-batched-commit-${pieceCount}.json`,
    batchCurioCommit: true,
    rawPieceSizeBytes: 3_500_000,
  });
}

function invalidSectorCount(): Error {
  return new Error(
    "SECTOR_EVIDENCE_BATCHED_COMMIT_SECTOR_COUNT must be a safe integer of at least 4",
  );
}
