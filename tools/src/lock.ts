import { readFile } from "node:fs/promises";

import { parse } from "yaml";

export interface ManagedSource {
  name: string;
  repository: string;
  commit: string;
  submodules: Record<string, string>;
}

export interface VersionLock {
  schemaVersion: 1;
  sources: Record<string, ManagedSource>;
}

export interface LoadVersionLockOptions {
  allowLocalRepositories?: boolean;
}

const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export async function loadVersionLock(path: string, options: LoadVersionLockOptions = {}): Promise<VersionLock> {
  const parsed: unknown = parse(await readFile(path, "utf8"));
  if (!isPlainRecord(parsed)) {
    throw new Error(`version lock ${path} must be a mapping`);
  }
  if (parsed.schema_version !== 1) {
    throw new Error(`version lock ${path} has unsupported schema_version ${String(parsed.schema_version)}`);
  }
  if (!isPlainRecord(parsed.sources)) {
    throw new Error(`version lock ${path} must contain a sources mapping`);
  }

  const sources: Record<string, ManagedSource> = {};
  const seenCheckouts = new Set<string>();
  for (const [name, source] of Object.entries(parsed.sources)) {
    rejectReservedKey("source", name);
    if (!isPlainRecord(source)) {
      throw new Error(`source ${name} must be a plain mapping`);
    }
    const repository = source.repository;
    if (typeof repository !== "string" || repository.length === 0) {
      throw new Error(`source ${name} must have a non-empty repository`);
    }
    validateRepository(name, repository, options);
    const commit = source.commit;
    if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) {
      throw new Error(`source ${name} commit must be exactly 40 lowercase hexadecimal characters`);
    }
    const submodules = parseSubmodules(name, source.submodules);
    const checkout = `${repository}\u0000${commit}`;
    if (seenCheckouts.has(checkout)) {
      throw new Error(`source ${name} duplicates a repository and commit checkout path`);
    }
    seenCheckouts.add(checkout);
    sources[name] = { name, repository, commit, submodules };
  }

  return { schemaVersion: 1, sources };
}

function validateRepository(sourceName: string, repository: string, options: LoadVersionLockOptions): void {
  if (!repository.startsWith("https://")) {
    if (!options.allowLocalRepositories) {
      throw new Error(`source ${sourceName} repository must use HTTPS`);
    }
    return;
  }
  let url: URL;
  try {
    url = new URL(repository);
  } catch {
    throw new Error(`source ${sourceName} repository must be a valid HTTPS URL`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`source ${sourceName} repository URL must not include credentials or userinfo`);
  }
  if (url.search !== "") {
    throw new Error(`source ${sourceName} repository URL must not include query or search text`);
  }
  if (url.hash !== "") {
    throw new Error(`source ${sourceName} repository URL must not include a fragment or hash`);
  }
}

export function managedSources(lock: VersionLock): ManagedSource[] {
  return Object.values(lock.sources);
}

function parseSubmodules(sourceName: string, value: unknown): Record<string, string> {
  if (value === undefined) {
    return {};
  }
  if (!isPlainRecord(value)) {
    throw new Error(`source ${sourceName} submodules must be a plain mapping`);
  }

  const submodules: Record<string, string> = {};
  for (const [name, commit] of Object.entries(value)) {
    rejectReservedKey(`source ${sourceName} submodule`, name);
    if (typeof commit !== "string" || !COMMIT_PATTERN.test(commit)) {
      throw new Error(`source ${sourceName} submodule ${name} must have a 40 lowercase hexadecimal commit`);
    }
    submodules[name] = commit;
  }
  return submodules;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectReservedKey(kind: string, key: string): void {
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    throw new Error(`reserved ${kind} key ${key}`);
  }
}
