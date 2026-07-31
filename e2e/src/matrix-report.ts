export type MatrixReportResult = {
  scenario: string;
  result: "passed" | "failed";
  infrastructure: boolean;
  skippedCapabilities: Record<string, string>;
};

type MatrixCounts = {
  total: number;
  passed: number;
  failed: number;
};

type SkippedCapability = {
  scenario: string;
  key: string;
  value: string;
};

export type ProviderCapacityReconciliation = {
  result: "passed" | "failed";
  error?: string;
  pending: {
    actualBytes: string;
    expectedBytes: string;
    deals: Array<{ dealId: string; bytes: string }>;
  };
  committed: {
    actualBytes: string;
    expectedBytes: string;
    deals: Array<{ dealId: string; bytes: string }>;
  };
};

export function unavailableProviderCapacityReconciliation(
  error: unknown,
): ProviderCapacityReconciliation {
  return {
    result: "failed",
    error: error instanceof Error ? error.message : String(error),
    pending: {
      actualBytes: "unavailable",
      expectedBytes: "unavailable",
      deals: [],
    },
    committed: {
      actualBytes: "unavailable",
      expectedBytes: "unavailable",
      deals: [],
    },
  };
}

export function matrixFinalResult(
  results: Array<{ result: "passed" | "failed" }>,
  reconciliation: ProviderCapacityReconciliation,
): "passed" | "failed" {
  return results.every((entry) => entry.result === "passed")
    && reconciliation.result === "passed"
    ? "passed"
    : "failed";
}

export function reconcileProviderCapacity(input: {
  provider: { pendingBytes: bigint; committedBytes: bigint };
  accepted: Array<{ dealId: bigint; reservedBytes: bigint }>;
  active: Array<{ dealId: bigint; committedBytes: bigint }>;
}): ProviderCapacityReconciliation {
  const pendingDeals = input.accepted.map(({ dealId, reservedBytes }) => ({
    dealId: dealId.toString(),
    bytes: reservedBytes.toString(),
  }));
  const committedDeals = input.active.map(({ dealId, committedBytes }) => ({
    dealId: dealId.toString(),
    bytes: committedBytes.toString(),
  }));
  const expectedPendingBytes = input.accepted.reduce(
    (sum, deal) => sum + deal.reservedBytes,
    0n,
  );
  const expectedCommittedBytes = input.active.reduce(
    (sum, deal) => sum + deal.committedBytes,
    0n,
  );

  return {
    result: input.provider.pendingBytes === expectedPendingBytes
      && input.provider.committedBytes === expectedCommittedBytes
      ? "passed"
      : "failed",
    pending: {
      actualBytes: input.provider.pendingBytes.toString(),
      expectedBytes: expectedPendingBytes.toString(),
      deals: pendingDeals,
    },
    committed: {
      actualBytes: input.provider.committedBytes.toString(),
      expectedBytes: expectedCommittedBytes.toString(),
      deals: committedDeals,
    },
  };
}

export function collectSkippedCapabilities(
  state: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(state).filter(([, value]) => value.startsWith("skipped:")),
  );
}

export function summarizeMatrixResults(results: MatrixReportResult[]): {
  behavior: MatrixCounts;
  infrastructure: MatrixCounts;
  skippedCapabilities: SkippedCapability[];
} {
  const count = (entries: MatrixReportResult[]): MatrixCounts => ({
    total: entries.length,
    passed: entries.filter((entry) => entry.result === "passed").length,
    failed: entries.filter((entry) => entry.result === "failed").length,
  });
  const infrastructure = results.filter((entry) => entry.infrastructure);

  return {
    behavior: count(results.filter((entry) => !entry.infrastructure)),
    infrastructure: count(infrastructure),
    skippedCapabilities: results.flatMap((entry) =>
      Object.entries(entry.skippedCapabilities).map(([key, value]) => ({
        scenario: entry.scenario,
        key,
        value,
      })),
    ),
  };
}
