import { lstat, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { parseActiveDeployment } from "./deployment.js";

export const DEFAULT_KEEP_DEPLOYMENTS = 2;

const TIMESTAMPED_DEPLOYMENT = /^deployment-\d{8}T\d{6}Z-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CONTRACT_TEST_SEED = /^contract-tests-(\d{8}T\d{6}Z)-(\d+)$/;
const REVISION_FILE = /^\d{3}\.json$/;
const UPGRADE_TARGET_FILE = /^upgrade-target-\d+\.json$/;
const SNAPSHOT_SEED = /\/\.runtime\/contracts\/targets\/([^/]+)(?:\/|$)/;

export type PruneEntry = {
  kind: "deployment" | "target";
  name: string;
  path: string;
  action: "keep" | "remove";
  reason: string;
  bytes: number;
};

export type PrunePlan = {
  projectRoot: string;
  keep: number;
  entries: PruneEntry[];
  removeBytes: number;
};

type PruneRoots = {
  projectRoot: string;
  deployments: string;
  targets: string;
};

export function parsePruneArguments(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): { keep: number; apply: boolean } {
  const usage = "usage: deployment prune [--keep <count>] [--apply]";
  if (args[0] !== "deployment" || args[1] !== "prune") throw new Error(usage);
  let keepValue = env.DEVNET_PRUNE_KEEP ?? String(DEFAULT_KEEP_DEPLOYMENTS);
  let apply = false;
  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === "--apply") {
      apply = true;
    } else if (args[index] === "--keep" && args[index + 1] !== undefined) {
      keepValue = args[index + 1] ?? "";
      index += 1;
    } else {
      throw new Error(usage);
    }
  }
  if (!/^\d+$/.test(keepValue) || !Number.isSafeInteger(Number(keepValue))) {
    throw new Error("prune keep count must be a non-negative integer");
  }
  return { keep: Number(keepValue), apply };
}

export async function planPrune(input: {
  projectRoot: string;
  keep: number;
}): Promise<PrunePlan> {
  const plan = await classifyPrune(input);
  for (const entry of plan.entries) {
    if (entry.action !== "remove") continue;
    await assertPrunablePath(plan.projectRoot, entry.path);
    entry.bytes = await diskUsage(entry.path);
    plan.removeBytes += entry.bytes;
  }
  return plan;
}

// Protection can change after the plan was shown (a deploy, upgrade, selector
// switch or test may have started), so deletion re-classifies first and only
// removes what both passes agree on.
export async function applyPrune(plan: PrunePlan): Promise<void> {
  const current = await classifyPrune({ projectRoot: plan.projectRoot, keep: plan.keep });
  const stillRemovable = new Set(
    current.entries.filter((entry) => entry.action === "remove").map((entry) => entry.path),
  );
  for (const entry of plan.entries) {
    if (entry.action !== "remove") continue;
    await assertPrunablePath(plan.projectRoot, entry.path);
    if (!stillRemovable.has(entry.path)) continue;
    await rm(entry.path, { recursive: true });
  }
}

async function classifyPrune(input: {
  projectRoot: string;
  keep: number;
}): Promise<PrunePlan> {
  if (!Number.isSafeInteger(input.keep) || input.keep < 0) {
    throw new Error("prune keep count must be a non-negative integer");
  }
  const roots = await pruneRoots(input.projectRoot);
  const deploymentNames = await childDirectories(roots.deployments);
  const targetNames = await childDirectories(roots.targets);

  const protectedDeployments = new Map<string, string>();
  const activePath = join(roots.deployments, "active.json");
  const activeSource = await readOptionalRegularFile(activePath);
  if (activeSource !== undefined) {
    protectedDeployments.set(parseActiveDeployment(activeSource).deploymentId, "active");
  }
  // An in-progress or interrupted adapter switch must be restorable on its deployment.
  const switchJournalPath = join(roots.projectRoot, ".runtime", "sector-evidence-adapter-switch.json");
  const switchJournal = await readOptionalJson(switchJournalPath);
  if (switchJournal !== undefined) {
    const deploymentId = switchJournal.deploymentId;
    if (typeof deploymentId === "string" && !protectedDeployments.has(deploymentId)) {
      protectedDeployments.set(deploymentId, "referenced by sector-evidence-adapter-switch.json");
    }
  }

  const entries: PruneEntry[] = [];
  const keptDeployments: string[] = [];
  const recent: string[] = [];
  for (const name of deploymentNames) {
    const path = join(roots.deployments, name);
    const protectedReason = protectedDeployments.get(name);
    let reason: string | undefined = protectedReason;
    if (reason === undefined && await exists(join(path, ".upgrade.lock"))) {
      reason = "upgrade in progress";
    }
    if (reason === undefined && await exists(join(path, ".deploy.lock"))) {
      reason = "deploy in progress";
    }
    if (reason === undefined && !TIMESTAMPED_DEPLOYMENT.test(name)) {
      reason = "unrecognized name";
    }
    if (reason === undefined) {
      recent.push(name);
      continue;
    }
    keptDeployments.push(name);
    entries.push({ kind: "deployment", name, path, action: "keep", reason, bytes: 0 });
  }
  // Deployment IDs start with a fixed-width UTC timestamp, so name order is age order.
  recent.sort((left, right) => right.localeCompare(left));
  for (const [index, name] of recent.entries()) {
    const path = join(roots.deployments, name);
    if (index < input.keep) {
      keptDeployments.push(name);
      entries.push({ kind: "deployment", name, path, action: "keep", reason: "recent", bytes: 0 });
    } else {
      entries.push({
        kind: "deployment",
        name,
        path,
        action: "remove",
        reason: `older than ${input.keep} most recent`,
        bytes: 0,
      });
    }
  }

  const targetOwners = new Map<string, string>();
  for (const deploymentId of keptDeployments) {
    for (const seed of await referencedTargetSeeds(join(roots.deployments, deploymentId))) {
      if (!targetOwners.has(seed)) targetOwners.set(seed, deploymentId);
    }
  }
  const newestContractTestSeed = targetNames
    .filter((name) => CONTRACT_TEST_SEED.test(name))
    .sort(compareContractTestSeeds)
    .at(-1);

  for (const name of targetNames) {
    const path = join(roots.targets, name);
    const owner = targetOwners.get(name)
      ?? keptDeployments.find((id) => name === id || name.startsWith(`${id}-upgrade-`));
    let action: PruneEntry["action"] = "keep";
    let reason: string;
    if (owner !== undefined) {
      reason = `belongs to ${owner}`;
    } else if (CONTRACT_TEST_SEED.test(name)) {
      if (name === newestContractTestSeed) {
        reason = "newest contract test seed";
      } else if (processIsAlive(Number(CONTRACT_TEST_SEED.exec(name)?.[2]))) {
        reason = "contract test still running";
      } else {
        action = "remove";
        reason = "older contract test seed";
      }
    } else if (name.startsWith("deployment-")) {
      action = "remove";
      reason = "no kept deployment references it";
    } else {
      reason = "unrecognized name";
    }
    entries.push({ kind: "target", name, path, action, reason, bytes: 0 });
  }

  return { projectRoot: roots.projectRoot, keep: input.keep, entries, removeBytes: 0 };
}

export async function assertPrunablePath(projectRoot: string, path: string): Promise<void> {
  const roots = await pruneRoots(projectRoot);
  const refuse = (detail: string): never => {
    throw new Error(`refusing to prune ${path}: ${detail}`);
  };
  if (!isAbsolute(path) || resolve(path) !== path) refuse("path must be absolute and normalized");
  const parent = dirname(path);
  const name = basename(path);
  if (parent !== roots.deployments && parent !== roots.targets) {
    refuse("path is outside .runtime/deployments and .runtime/contracts/targets");
  }
  if (name === "" || name === "." || name === ".." || name === "active.json") {
    refuse("path name is not prunable");
  }
  const info = await lstat(path);
  if (info.isSymbolicLink()) refuse("path must not be symbolic");
  if (!info.isDirectory()) refuse("path is not a directory");
  if (await realpath(path) !== path) refuse("path must be a real path");
}

export function formatPrunePlan(plan: PrunePlan, applied: boolean): string {
  const lines = plan.entries.map((entry) => [
    entry.action,
    entry.kind,
    entry.name,
    entry.action === "remove" ? formatBytes(entry.bytes) : "-",
    entry.reason,
  ].join("\t"));
  const count = plan.entries.filter((entry) => entry.action === "remove").length;
  lines.push(applied
    ? `removed ${count} entries, ${formatBytes(plan.removeBytes)}`
    : `dry run: would remove ${count} entries, ${formatBytes(plan.removeBytes)}; rerun with --apply to delete`);
  return `${lines.join("\n")}\n`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

// Mirrors devnet_require_safe_write_path: every component from the real project
// root down to each prune root must be a real, non-symbolic directory.
async function pruneRoots(projectRoot: string): Promise<PruneRoots> {
  const root = await realpath(resolve(projectRoot));
  for (const relativePath of [".runtime", ".runtime/deployments", ".runtime/contracts", ".runtime/contracts/targets"]) {
    const path = join(root, relativePath);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) continue;
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`refusing to prune: runtime path must not be symbolic: ${path}`);
    if (!info.isDirectory()) throw new Error(`refusing to prune: runtime path is not a directory: ${path}`);
  }
  return {
    projectRoot: root,
    deployments: join(root, ".runtime", "deployments"),
    targets: join(root, ".runtime", "contracts", "targets"),
  };
}

async function childDirectories(root: string): Promise<string[]> {
  let children;
  try {
    children = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
  const names: string[] = [];
  for (const child of children) {
    if (child.isSymbolicLink()) {
      throw new Error(`refusing to prune: runtime path must not be symbolic: ${join(root, child.name)}`);
    }
    if (child.isDirectory()) names.push(child.name);
  }
  return names.sort();
}

async function referencedTargetSeeds(deploymentPath: string): Promise<Set<string>> {
  const seeds = new Set<string>();
  const record = async (path: string, select: (value: Record<string, unknown>) => unknown) => {
    const value = await readOptionalJson(path);
    if (value === undefined) return;
    const snapshotPath = select(value);
    if (typeof snapshotPath !== "string") return;
    const seed = SNAPSHOT_SEED.exec(snapshotPath)?.[1];
    if (seed !== undefined) seeds.add(seed);
  };
  const snapshotOf = (value: Record<string, unknown>) => value.snapshotPath;
  await record(join(deploymentPath, "target.json"), snapshotOf);
  for (const name of await fileNames(deploymentPath)) {
    if (UPGRADE_TARGET_FILE.test(name)) await record(join(deploymentPath, name), snapshotOf);
  }
  for (const name of await fileNames(join(deploymentPath, "revisions"))) {
    if (!REVISION_FILE.test(name)) continue;
    await record(join(deploymentPath, "revisions", name), (value) => {
      const target = value.target;
      return typeof target === "object" && target !== null
        ? (target as Record<string, unknown>).snapshotPath
        : undefined;
    });
  }
  return seeds;
}

async function fileNames(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

async function readOptionalRegularFile(path: string): Promise<string | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`refusing to prune: ${path} must be a regular file`);
  }
  return readFile(path, "utf8");
}

// Unreadable references make the kept set unknowable, so they stop the prune.
async function readOptionalJson(path: string): Promise<Record<string, unknown> | undefined> {
  const source = await readOptionalRegularFile(path);
  if (source === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`refusing to prune: cannot read references from ${path}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`refusing to prune: cannot read references from ${path}`);
  }
  return value as Record<string, unknown>;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw error;
  }
}

async function diskUsage(path: string): Promise<number> {
  const info = await lstat(path);
  if (!info.isDirectory()) return info.blocks * 512;
  let total = info.blocks * 512;
  for (const child of await readdir(path)) total += await diskUsage(join(path, child));
  return total;
}

function compareContractTestSeeds(left: string, right: string): number {
  const leftMatch = CONTRACT_TEST_SEED.exec(left);
  const rightMatch = CONTRACT_TEST_SEED.exec(right);
  const byTime = (leftMatch?.[1] ?? "").localeCompare(rightMatch?.[1] ?? "");
  return byTime !== 0 ? byTime : Number(leftMatch?.[2]) - Number(rightMatch?.[2]);
}

// Contract test seeds embed the host shell PID; a reused PID only keeps a seed longer.
function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isNodeError(error, "ESRCH");
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
