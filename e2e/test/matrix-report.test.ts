import assert from "node:assert/strict";
import test from "node:test";
import {
  collectSkippedCapabilities,
  summarizeMatrixResults,
} from "../src/matrix-report.js";

test("matrix summary separates infrastructure from behavior pass counts", () => {
  const summary = summarizeMatrixResults([
    {
      scenario: "prepare-devnet",
      result: "passed",
      infrastructure: true,
      skippedCapabilities: {},
    },
    {
      scenario: "settlement-guards",
      result: "passed",
      infrastructure: false,
      skippedCapabilities: {},
    },
    {
      scenario: "termination-settlement",
      result: "failed",
      infrastructure: false,
      skippedCapabilities: {},
    },
  ]);

  assert.deepEqual(summary.infrastructure, { total: 1, passed: 1, failed: 0 });
  assert.deepEqual(summary.behavior, { total: 2, passed: 1, failed: 1 });
});

test("matrix summary exposes every skipped state capability", () => {
  const skippedCapabilities = collectSkippedCapabilities({
    SECTOR_STATUS_FAULTY_FIXTURE: "skipped: no deterministic bounded fault injection",
    SECTOR_STATUS_TERMINATED_FIXTURE: "skipped: no deterministic bounded termination fixture",
    DEAL_ID: "12",
  });
  const summary = summarizeMatrixResults([
    {
      scenario: "sector-status-active",
      result: "passed",
      infrastructure: false,
      skippedCapabilities,
    },
  ]);

  assert.deepEqual(skippedCapabilities, {
    SECTOR_STATUS_FAULTY_FIXTURE: "skipped: no deterministic bounded fault injection",
    SECTOR_STATUS_TERMINATED_FIXTURE: "skipped: no deterministic bounded termination fixture",
  });
  assert.deepEqual(summary.skippedCapabilities, [
    {
      scenario: "sector-status-active",
      key: "SECTOR_STATUS_FAULTY_FIXTURE",
      value: "skipped: no deterministic bounded fault injection",
    },
    {
      scenario: "sector-status-active",
      key: "SECTOR_STATUS_TERMINATED_FIXTURE",
      value: "skipped: no deterministic bounded termination fixture",
    },
  ]);
  assert.equal(summary.behavior.passed, 1);
});
