import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ScenarioContext } from "../src/runtime.js";
import { recoverSwitchJournal } from "../src/scenarios/sectorEvidenceMultiPieceActivation.js";

test("a restored adapter switch journal does not bind the next deployment", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sector-evidence-switch-journal-"));
  const runtime = join(projectRoot, ".runtime");
  await mkdir(runtime);
  await writeFile(
    join(runtime, "sector-evidence-adapter-switch.json"),
    `${JSON.stringify({
      generation: "generation-one",
      deploymentId: "deployment-one",
      revision: 0,
      poRepMarket: "0x1111111111111111111111111111111111111111",
      originalAdapter: "0x2222222222222222222222222222222222222222",
      targetAdapter: "0x3333333333333333333333333333333333333333",
      status: "restored",
    })}\n`,
  );

  let readLiveAdapter = false;
  try {
    await recoverSwitchJournal(
      { projectRoot } as ScenarioContext,
      {
        getGlobalEvidenceAdapter: () => {
          readLiveAdapter = true;
          throw new Error("restored journal read live adapter");
        },
      },
      {
        generation: "generation-one",
        deploymentId: "deployment-two",
        revision: 0,
        poRepMarket: "0x4444444444444444444444444444444444444444",
        originalAdapter: "0x5555555555555555555555555555555555555555",
        targetAdapter: "0x6666666666666666666666666666666666666666",
        status: "pending",
      },
    );
    assert.equal(readLiveAdapter, false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
