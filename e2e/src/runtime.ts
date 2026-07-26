import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { E2EConfig } from "./config.js";
import { StateStore } from "./state.js";
import { run } from "./shell.js";

export type ScenarioContext = {
  config: E2EConfig;
  runId: string;
  runDir: string;
  stateFile: string;
  projectRoot: string;
  scriptsRoot: string;
  state: StateStore;
  steps: string[];
};

export function createScenarioContext(
  config: E2EConfig,
  runDir: string,
  runId = runDir.split("/").at(-1) ?? "scenario-run",
): ScenarioContext {
  mkdirSync(runDir, { recursive: true });

  return {
    config,
    runId,
    runDir,
    stateFile: join(runDir, "scenario.state.json"),
    projectRoot: config.projectRoot,
    scriptsRoot: config.projectRoot,
    state: new StateStore(join(runDir, "scenario.state.json")),
    steps: []
  };
}

export async function runStep<T>(
  context: ScenarioContext,
  name: string,
  action: () => T | Promise<T>
): Promise<T> {
  const label = `${context.steps.length + 1} ${name}`;
  const started = Date.now();
  context.steps.push(name);
  console.log(`\n== ${label} ==`);

  try {
    const result = await action();
    const elapsedMs = Date.now() - started;
    writeFileSync(
      join(context.runDir, `${String(context.steps.length).padStart(2, "0")}-${slug(name)}.json`),
      `${JSON.stringify({ name, elapsedMs, result }, stringifyBigInt, 2)}\n`
    );
    console.log(`Completed ${name} in ${elapsedMs}ms`);
    return result;
  } catch (error) {
    const elapsedMs = Date.now() - started;
    writeFileSync(
      join(context.runDir, `${String(context.steps.length).padStart(2, "0")}-${slug(name)}.error.json`),
      `${JSON.stringify({
        name,
        elapsedMs,
        error: error instanceof Error ? error.message : String(error)
      }, null, 2)}\n`
    );
    throw error;
  }
}

export function writeRunSummary(
  context: ScenarioContext,
  result: "passed" | "failed" = "passed",
  error?: unknown,
): string {
  const summaryPath = join(context.runDir, "summary.json");
  writeFileSync(
    summaryPath,
    `${JSON.stringify({
      completedAt: new Date().toISOString(),
      result,
      runId: context.runId,
      deploymentId: context.config.deploymentId,
      deploymentRevision: context.config.deploymentRevision,
      deploymentRecordPath: context.config.deploymentRecordPath,
      runDir: context.runDir,
      stateFile: context.stateFile,
      steps: context.steps,
      state: context.state.all(),
      ...(error === undefined
        ? {}
        : { error: error instanceof Error ? error.message : String(error) }),
    }, null, 2)}\n`
  );
  console.log(`\nRun summary: ${summaryPath}`);
  return summaryPath;
}

export function writeFailureDiagnostics(context: ScenarioContext): string {
  const path = join(context.runDir, "failure-diagnostics.log");
  const result = run("docker", [
    "compose",
    "--env-file",
    join(context.projectRoot, ".runtime/devnet/compose.env"),
    "--project-name",
    "porep-market-curio-devnet",
    "--file",
    join(context.projectRoot, "docker/compose.curio-devnet.yaml"),
    "logs",
    "--tail",
    "200",
    "curio",
    "lotus",
    "yugabyte",
  ], context.projectRoot);
  const output = `${result.stdout}\n${result.stderr}`.slice(-512_000);
  writeFileSync(path, output);
  context.state.set("FAILURE_DIAGNOSTICS", path);
  return path;
}

export function envValue(context: ScenarioContext, key: string, fallback = ""): string {
  return context.config.env[key] ?? process.env[key] ?? fallback;
}

export function envBigInt(context: ScenarioContext, key: string, fallback: bigint): bigint {
  const value = envValue(context, key);
  return value ? BigInt(value) : fallback;
}

export function envNumber(context: ScenarioContext, key: string, fallback: number): number {
  const value = envValue(context, key);
  return value ? Number(value) : fallback;
}

export function defaultDepositAmountHuman(context: ScenarioContext): string {
  const override = envValue(context, "V2_DEPOSIT_AMOUNT");
  if (override) return override;

  const pricePerMonth = envBigInt(context, "V2_PRICE_PER_32GIB_MONTH", 86_400_000_000n);
  const withMargin = (pricePerMonth * 110n + 99n) / 100n;
  return ((withMargin + 999_999n) / 1_000_000n).toString();
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function stringifyBigInt(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}
