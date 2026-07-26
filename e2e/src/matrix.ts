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
  resolveScenario,
  resolveSuite,
} from "./scenarios/registry.js";

type MatrixResult = {
  scenario: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  result: "passed" | "failed";
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

mkdirSync(matrixDir, { recursive: true });

for (const name of selectedScenarios) {
  const result = await runScenario(name, results.length + 1);
  results.push(result);
  writeReport();
  if (failFast && result.result === "failed") break;
}

const failed = results.filter((result) => result.result === "failed");
writeReport(new Date().toISOString());
console.log(`\nMatrix report: ${reportPath}`);
console.log(`Matrix result: ${results.length - failed.length}/${results.length} passed`);

if (failed.length > 0) {
  process.exitCode = 1;
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

  return {
    scenario: name,
    startedAt: scenarioStartedAt,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    result: exitCode === 0 ? "passed" : "failed",
    exitCode,
    summaryPath,
    logPath,
    stateIds: readStateIds(summaryPath),
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

function readStateIds(summaryPath: string | null): Record<string, string> {
  if (!summaryPath || !existsSync(summaryPath)) return {};

  const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
    state?: Record<string, string>;
  };
  return Object.fromEntries(
    Object.entries(summary.state ?? {}).filter(([key]) =>
      /(^PROVIDER$|_ID$|_IDS_CSV$|^SECTOR_NUMBER$)/.test(key),
    ),
  );
}

function writeReport(completedAt?: string): void {
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
        ? results.every((entry) => entry.result === "passed")
          ? "passed"
          : "failed"
        : "running",
      scenarios: results,
    }, null, 2)}\n`,
  );
}
