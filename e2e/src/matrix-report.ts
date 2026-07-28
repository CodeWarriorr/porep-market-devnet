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
