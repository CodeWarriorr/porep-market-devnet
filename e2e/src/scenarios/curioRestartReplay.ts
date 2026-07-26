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
import { runRequired, sleep } from "../shell.js";

const receiverAbi = [
  "function calls() view returns (uint256)",
  "function uniquePieces() view returns (uint256)",
  "function lastSector() view returns (uint64)",
  "function lastPieceDigest() view returns (bytes32)",
];

export async function runCurioRestartReplay(
  context: ScenarioContext,
): Promise<void> {
  const receiver = new Evm(context).contract(
    context.config.addresses.notificationReceiver,
    receiverAbi,
  );
  const callsBefore = await receiver.calls() as bigint;
  const uniqueBefore = await receiver.uniquePieces() as bigint;
  const piece = await runStep(context, "generate replay-test piece", () =>
    generatePieceAndAssertCommp(context));
  const deal = await runStep(context, "submit replay-test onboarding", () =>
    submitCurioNotification(
      context,
      piece,
      context.config.addresses.notificationReceiver,
    ));

  await runStep(context, "restart Curio after durable submission", () => {
    runRequired("docker", [
      "compose",
      "--env-file",
      `${context.projectRoot}/.runtime/devnet/compose.env`,
      "--project-name",
      "porep-market-curio-devnet",
      "--file",
      `${context.projectRoot}/docker/compose.curio-devnet.yaml`,
      "restart",
      "curio",
    ], context.projectRoot);
  });

  const pipeline = await runStep(context, "wait for replay terminal success", () =>
    waitForCurioSector(context, deal.dealId));
  await runStep(context, "assert exactly one receiver effect", async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (await receiver.calls() as bigint === callsBefore + 1n) break;
      await sleep(5000);
    }
    assert.equal(await receiver.calls() as bigint, callsBefore + 1n);
    assert.equal(await receiver.uniquePieces() as bigint, uniqueBefore + 1n);
    assert.equal(await receiver.lastSector() as bigint, BigInt(pipeline.sector!));
    await sleep(20_000);
    assert.equal(
      await receiver.calls() as bigint,
      callsBefore + 1n,
      "Curio restart replayed the receiver call",
    );
  });

  await recordActiveSectorFixture(context, pipeline.sector!, piece.pieceCid);
  context.state.set("CURIO_RESTART_DEAL_ID", deal.dealId);
  context.state.set("CURIO_RESTART_SECTOR", pipeline.sector!);
}
