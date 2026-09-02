import type { ScenarioContext } from "../runtime.js";
import { runSectorEvidenceRefresh } from "./sectorEvidenceMultiPieceActivation.js";

const DEFAULT_LARGE_SECTOR_COUNT = 16;

export function largeSectorCount(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LARGE_SECTOR_COUNT;
  if (!/^[0-9]+$/.test(raw)) throw invalidSectorCount();
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 3) throw invalidSectorCount();
  return count;
}

export async function runSectorEvidenceLargeRefresh(
  context: ScenarioContext,
): Promise<void> {
  await runSectorEvidenceRefresh(context, {
    pieceCount: largeSectorCount(
      context.config.env.SECTOR_EVIDENCE_LARGE_SECTOR_COUNT,
    ),
    artifactFileName: "curio-sector-evidence-large-refresh.json",
  });
}

function invalidSectorCount(): Error {
  return new Error(
    "SECTOR_EVIDENCE_LARGE_SECTOR_COUNT must be a safe integer of at least 3",
  );
}
