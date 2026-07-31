import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ScenarioContext } from "../src/runtime.js";
import {
  assertScenarioPrerequisites,
  consumeScenarioFixtures,
  type ScenarioDefinition,
} from "../src/scenarios/registry.js";

test("scenario prerequisites report every missing deployment contract on one line", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "scenario-prerequisites-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const deploymentRecordPath = join(directory, "000.json");
  writeFileSync(
    deploymentRecordPath,
    JSON.stringify({ contracts: { PoRepMarket: { address: "0x1" } } }),
  );

  assert.throws(
    () => assertScenarioPrerequisites(
      "sector-status-active",
      definition({ requiredContracts: ["PoRepMarket", "SectorStatusInspector"] }),
      deploymentRecordPath,
    ),
    {
      message:
        "scenario prerequisite failed: sector-status-active requires deployment contract SectorStatusInspector",
    },
  );
});

test("scenario prerequisites accept deployment records containing every required contract", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "scenario-prerequisites-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const deploymentRecordPath = join(directory, "000.json");
  writeFileSync(
    deploymentRecordPath,
    JSON.stringify({
      contracts: {
        PoRepMarket: { address: "0x1" },
        SectorStatusInspector: { address: "0x2" },
      },
    }),
  );

  assert.doesNotThrow(() => assertScenarioPrerequisites(
    "sector-status-active",
    definition({ requiredContracts: ["PoRepMarket", "SectorStatusInspector"] }),
    deploymentRecordPath,
  ));
});

test("scenario fixture dispatch consumes the active-sector declaration", async () => {
  const context = {} as ScenarioContext;
  const calls: ScenarioContext[] = [];

  await consumeScenarioFixtures(
    context,
    definition({ fixtures: ["active-sector"] }),
    async (received) => {
      calls.push(received);
      return {
        generation: "generation-test",
        provider: "t01004",
        sector: 7,
        deadline: 1,
        partition: 0,
        pieceCid: "baga",
        createdByRunId: "test",
      };
    },
  );

  assert.deepEqual(calls, [context]);
});

function definition(
  overrides: Partial<ScenarioDefinition> = {},
): ScenarioDefinition {
  return {
    run: async () => {},
    tags: ["contract"],
    timeoutMs: 1,
    requiredContracts: [],
    ...overrides,
  };
}
