import assert from "node:assert/strict";
import test from "node:test";
import {
  collectSkippedCapabilities,
  summarizeMatrixResults,
} from "../src/matrix-report.js";
import * as matrixReport from "../src/matrix-report.js";

type ReconcileProviderCapacity = (input: {
  provider: { pendingBytes: bigint; committedBytes: bigint };
  accepted: Array<{ dealId: bigint; reservedBytes: bigint }>;
  active: Array<{ dealId: bigint; committedBytes: bigint }>;
}) => {
  result: "passed" | "failed";
  pending: { actualBytes: string; expectedBytes: string; deals: Array<{ dealId: string; bytes: string }> };
  committed: { actualBytes: string; expectedBytes: string; deals: Array<{ dealId: string; bytes: string }> };
};

type MatrixFinalResult = (
  scenarios: Array<{ result: "passed" | "failed" }>,
  reconciliation: { result: "passed" | "failed" },
) => "passed" | "failed";

type UnavailableProviderCapacityReconciliation = (error: unknown) => {
  result: "failed";
  error: string;
  pending: { actualBytes: string; expectedBytes: string; deals: [] };
  committed: { actualBytes: string; expectedBytes: string; deals: [] };
};

test("provider capacity reconciliation reports exact per-deal sums and drift", () => {
  const reconcile = Reflect.get(matrixReport, "reconcileProviderCapacity") as ReconcileProviderCapacity;
  assert.equal(typeof reconcile, "function", "capacity reconciliation is exported");

  const report = reconcile({
    provider: { pendingBytes: 5n, committedBytes: 13n },
    accepted: [
      { dealId: 7n, reservedBytes: 2n },
      { dealId: 9n, reservedBytes: 3n },
    ],
    active: [
      { dealId: 11n, committedBytes: 13n },
    ],
  });

  assert.deepEqual(report, {
    result: "passed",
    pending: {
      actualBytes: "5",
      expectedBytes: "5",
      deals: [
        { dealId: "7", bytes: "2" },
        { dealId: "9", bytes: "3" },
      ],
    },
    committed: {
      actualBytes: "13",
      expectedBytes: "13",
      deals: [{ dealId: "11", bytes: "13" }],
    },
  });

  const skewed = reconcile({
    provider: { pendingBytes: 6n, committedBytes: 13n },
    accepted: [{ dealId: 7n, reservedBytes: 5n }],
    active: [{ dealId: 11n, committedBytes: 13n }],
  });
  assert.equal(skewed.result, "failed");
  assert.deepEqual(skewed.pending, {
    actualBytes: "6",
    expectedBytes: "5",
    deals: [{ dealId: "7", bytes: "5" }],
  });
});

test("matrix final result fails when reconciliation fails after passing scenarios", () => {
  const finalResult = Reflect.get(matrixReport, "matrixFinalResult") as MatrixFinalResult;
  assert.equal(typeof finalResult, "function", "matrix final result is exported");
  assert.equal(
    finalResult([{ result: "passed" }], { result: "failed" }),
    "failed",
  );
});

test("unavailable reconciliation serializes a read failure as a failed report block", () => {
  const unavailable = Reflect.get(
    matrixReport,
    "unavailableProviderCapacityReconciliation",
  ) as UnavailableProviderCapacityReconciliation;
  assert.equal(typeof unavailable, "function", "unavailable reconciliation is exported");
  assert.deepEqual(unavailable(new Error("RPC read failed")), {
    result: "failed",
    error: "RPC read failed",
    pending: { actualBytes: "unavailable", expectedBytes: "unavailable", deals: [] },
    committed: { actualBytes: "unavailable", expectedBytes: "unavailable", deals: [] },
  });
});

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
