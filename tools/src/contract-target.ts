import { cp, lstat, mkdir, realpath } from "node:fs/promises";
import { devNull } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { loadVersionLock } from "./lock.js";
import { run } from "./process.js";

const SAFE_SEED = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const COMMIT = /^[0-9a-f]{40}$/;
const EXCLUDED_ROOTS = new Set(["out", "cache", "broadcast"]);

export type ContractTarget = {
  mode: "locked" | "local";
  sourcePath: string;
  snapshotPath: string;
  commit: string;
  dirty: boolean;
  submodules: Record<string, string>;
};

export async function prepareContractTarget(input: {
  projectRoot: string;
  sourcePath?: string;
  deploymentSeed: string;
}): Promise<ContractTarget> {
  if (!SAFE_SEED.test(input.deploymentSeed)) {
    throw new Error("contract target deployment seed is invalid");
  }
  const projectRoot = await realpath(resolve(input.projectRoot));
  const lock = await loadVersionLock(join(projectRoot, "versions.lock.yaml"));
  const locked = lock.sources.porep_market;
  if (locked === undefined) throw new Error("version lock has no porep_market source");

  if (input.sourcePath !== undefined && !isAbsolute(input.sourcePath)) {
    throw new Error("contract target source must be an absolute path");
  }
  const mode = input.sourcePath === undefined ? "locked" : "local";
  const selectedPath = input.sourcePath
    ?? join(projectRoot, ".cache", "sources", "porep_market", locked.commit);
  const info = await lstat(selectedPath);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("contract target source must be a real directory");
  }
  const sourcePath = await realpath(selectedPath);
  const commit = await gitOutput(sourcePath, ["rev-parse", "HEAD"]);
  if (!COMMIT.test(commit)) throw new Error("contract target HEAD is invalid");
  const dirty = (await gitOutput(sourcePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--ignore-submodules=none",
  ])) !== "";
  if (mode === "locked" && (commit !== locked.commit || dirty)) {
    throw new Error("locked contract target must match its clean pinned commit");
  }

  const snapshotPath = join(
    projectRoot,
    ".runtime",
    "contracts",
    "targets",
    input.deploymentSeed,
    "porep-market",
  );
  try {
    await lstat(snapshotPath);
    throw new Error(`contract target snapshot already exists: ${snapshotPath}`);
  } catch (error) {
    if (!(isNodeError(error, "ENOENT"))) throw error;
  }
  await mkdir(join(snapshotPath, ".."), { recursive: true });
  await cp(sourcePath, snapshotPath, {
    recursive: true,
    filter: (entry) => includeSnapshotEntry(sourcePath, entry),
  });

  return {
    mode,
    sourcePath,
    snapshotPath,
    commit,
    dirty,
    submodules: parseSubmodules(await gitOutput(sourcePath, ["submodule", "status", "--recursive"])),
  };
}

function includeSnapshotEntry(root: string, entry: string): boolean {
  const path = relative(root, entry);
  if (path === "") return true;
  const segments = path.split(sep);
  if (segments.includes(".git")) return false;
  if (segments.length === 1 && EXCLUDED_ROOTS.has(segments[0] ?? "")) return false;
  return !(segments[0] === "deployments" && segments.includes("upgrades"));
}

function parseSubmodules(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^[ +U-]?([0-9a-f]{40})\s+(\S+)/.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error("contract target has an unreadable submodule status");
    }
    values[match[2]] = match[1];
  }
  return values;
}

async function gitOutput(cwd: string, args: string[]): Promise<string> {
  return (await run("git", ["--no-optional-locks", ...args], {
    cwd,
    env: sanitizedGitEnvironment(),
    timeoutMs: 60_000,
  })).stdout.trim();
}

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.toUpperCase().startsWith("GIT_")) continue;
    environment[name] = value;
  }
  environment.GIT_CONFIG_GLOBAL = devNull;
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_TERMINAL_PROMPT = "0";
  return environment;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
