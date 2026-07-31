import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import {
  collectSkippedCapabilities,
  matrixFinalResult,
  reconcileProviderCapacity,
  summarizeMatrixResults,
  type MatrixReportResult,
  type ProviderCapacityReconciliation,
  unavailableProviderCapacityReconciliation,
} from "./matrix-report.js";
import { contracts } from "./contracts/views.js";
import { createScenarioContext } from "./runtime.js";
import {
  resolveScenario,
  resolveSuite,
} from "./scenarios/registry.js";

type MatrixResult = MatrixReportResult & {
  startedAt: string;
  completedAt: string;
  durationMs: number;
  exitCode: number;
  summaryPath: string | null;
  logPath: string;
  stateIds: Record<string, string>;
};

const config = loadConfig({ cwd: process.cwd() });
const suite = process.argv[2] ?? "full";
const failFast = process.argv.includes("--fail-fast");
const selectedScenarios = resolveSuite(suite);
const startedAt = new Date().toISOString();
const matrixDir = join(
  config.runRoot,
  `${startedAt.replace(/[:.]/g, "-")}-matrix`,
);
const reportPath = join(matrixDir, "matrix-report.json");
const results: MatrixResult[] = [];
let reconciliation: ProviderCapacityReconciliation | null = null;

mkdirSync(matrixDir, { recursive: true });

for (const name of selectedScenarios) {
  const result = await runScenario(name, results.length + 1);
  results.push(result);
  writeReport();
  if (failFast && result.result === "failed") break;
}

try {
  reconciliation = await reconcileProviderCapacityFromChain();
} catch (error) {
  reconciliation = unavailableProviderCapacityReconciliation(error);
}
const failed = results.filter((result) => result.result === "failed");
const summary = summarizeMatrixResults(results);
writeReport(new Date().toISOString());
console.log(`\nMatrix report: ${reportPath}`);
console.log(
  `Behavior scenarios: ${summary.behavior.passed}/${summary.behavior.total} passed`,
);
console.log(
  `Infrastructure scenarios: ${summary.infrastructure.passed}/${summary.infrastructure.total} passed`,
);
console.log(
  `Provider capacity reconciliation: ${reconciliation.result} `
    + `(pending ${reconciliation.pending.actualBytes}/${reconciliation.pending.expectedBytes}, `
    + `committed ${reconciliation.committed.actualBytes}/${reconciliation.committed.expectedBytes})`,
);
if (reconciliation.error) {
  console.log(`Provider capacity reconciliation error: ${reconciliation.error}`);
}
console.log(`Matrix result (all scenarios): ${results.length - failed.length}/${results.length} passed`);
if (summary.skippedCapabilities.length > 0) {
  console.log("Skipped capabilities:");
  for (const capability of summary.skippedCapabilities) {
    console.log(`  ${capability.scenario} ${capability.key}: ${capability.value}`);
  }
}

if (failed.length > 0 || reconciliation.result === "failed") {
  process.exitCode = 1;
}

async function reconcileProviderCapacityFromChain(): Promise<ProviderCapacityReconciliation> {
  const view = contracts(createScenarioContext(config, matrixDir, "matrix-reconciliation"));
  const provider = BigInt(config.provider.slice(2));
  const [acceptedIds, activeIds, providerCapacity] = await Promise.all([
    dealIdsByState(view, 20n),
    dealIdsByState(view, 30n),
    view.providerCapacity(provider),
  ]);
  const [accepted, active] = await Promise.all([
    Promise.all(acceptedIds.map(async (dealId) => ({
      dealId,
      reservedBytes: (await view.dealCapacity(dealId)).reservedBytes,
    }))),
    Promise.all(activeIds.map(async (dealId) => ({
      dealId,
      committedBytes: (await view.dealCapacity(dealId)).committedBytes,
    }))),
  ]);
  return reconcileProviderCapacity({ provider: providerCapacity, accepted, active });
}

async function dealIdsByState(
  view: ReturnType<typeof contracts>,
  state: bigint,
): Promise<bigint[]> {
  const pageSize = 100n;
  const first = await view.dealIdsByState(state, 0n, pageSize);
  const dealIds = [...first.dealIds];
  for (let offset = BigInt(dealIds.length); offset < first.total; offset += pageSize) {
    const page = await view.dealIdsByState(state, offset, pageSize);
    dealIds.push(...page.dealIds);
  }
  return dealIds;
}

async function runScenario(name: string, index: number): Promise<MatrixResult> {
  const scenarioStartedAt = new Date().toISOString();
  const startedMs = Date.now();
  const logPath = join(
    matrixDir,
    `${String(index).padStart(2, "0")}-${name}.log`,
  );
  writeFileSync(logPath, "");
  console.log(`\n## Matrix ${index}/${selectedScenarios.length}: ${name}`);
  const runDir = join(
    matrixDir,
    `${String(index).padStart(2, "0")}-${name}`,
  );
  const summaryPath = join(runDir, "summary.json");

  const exitCode = await runChild(
    name,
    runDir,
    logPath,
    resolveScenario(name).timeoutMs,
  );
  if (!existsSync(summaryPath)) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      summaryPath,
      `${JSON.stringify({
        completedAt: new Date().toISOString(),
        result: "failed",
        runId: `${String(index).padStart(2, "0")}-${name}`,
        deploymentId: config.deploymentId,
        deploymentRevision: config.deploymentRevision,
        deploymentRecordPath: config.deploymentRecordPath,
        runDir,
        steps: [],
        state: {},
        error: `scenario process exited with code ${exitCode} before publishing a summary`,
      }, null, 2)}\n`,
    );
  }
  const summaryState = readSummaryState(summaryPath);

  return {
    scenario: name,
    startedAt: scenarioStartedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    result: exitCode === 0 ? "passed" : "failed",
    exitCode,
    summaryPath,
    logPath,
    stateIds: readStateIds(summaryState),
    infrastructure: resolveScenario(name).tags.includes("infra"),
    skippedCapabilities: collectSkippedCapabilities(summaryState),
  };
}

function runChild(
  name: string,
  runDir: string,
  logPath: string,
  timeoutMs: number,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      "npm",
      ["--prefix", "e2e", "run", "scenario", "--", name],
      {
        cwd: config.projectRoot,
        detached: true,
        env: { ...process.env, SCENARIO_RUN_DIR: runDir },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      appendFileSync(logPath, `\nscenario timeout after ${timeoutMs}ms\n`);
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // The child completed while the timeout callback was queued.
        }
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      appendFileSync(logPath, text);
      process.stdout.write(text);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      appendFileSync(logPath, text);
      process.stderr.write(text);
    });
    child.once("error", (error) => {
      appendFileSync(logPath, `\n${error.message}\n`);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(1);
      }
    });
    child.once("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(timedOut ? 124 : (code ?? 1));
      }
    });
  });
}

function readSummaryState(summaryPath: string | null): Record<string, string> {
  if (!summaryPath || !existsSync(summaryPath)) return {};

  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
    state?: Record<string, string>;
  };
  return summary.state ?? {};
}

function readStateIds(state: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(state).filter(([key]) =>
      /(^PROVIDER$|_ID$|_IDS_CSV$|^SECTOR_NUMBER$)/.test(key),
    ),
  );
}

function writeReport(completedAt?: string): void {
  const summary = summarizeMatrixResults(results);
  writeFileSync(
    reportPath,
    `${JSON.stringify({
      startedAt,
      completedAt,
      suite,
      failFast,
      matrixDir,
      reportPath,
      result: completedAt
        ? matrixFinalResult(results, reconciliation ?? unavailableProviderCapacityReconciliation(
          "reconciliation did not complete",
        ))
        : "running",
      behavior: summary.behavior,
      infrastructure: summary.infrastructure,
      reconciliation,
      skippedCapabilities: summary.skippedCapabilities,
      scenarios: results,
    }, null, 2)}\n`,
  );
}
