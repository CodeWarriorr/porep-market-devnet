import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { ScenarioContext } from "../runtime.js";
import { sleep } from "../shell.js";

export type ActiveSectorFixture = {
  generation: string;
  provider: string;
  sector: number;
  deadline: number;
  partition: number;
  pieceCid: string;
  createdByRunId: string;
};

type FixtureDependencies = {
  isActive: (
    context: ScenarioContext,
    fixture: ActiveSectorFixture,
  ) => Promise<boolean>;
  create: (
    context: ScenarioContext,
  ) => Promise<ActiveSectorFixture>;
  discover?: (
    context: ScenarioContext,
  ) => Promise<ActiveSectorFixture | undefined>;
  waitUntilActive?: (
    context: ScenarioContext,
    fixture: ActiveSectorFixture,
  ) => Promise<boolean>;
};

export function activeSectorFixturePath(context: ScenarioContext): string {
  return join(
    context.projectRoot,
    ".runtime",
    "fixtures",
    context.config.generation,
    "active-sector.json",
  );
}

export async function ensureActiveSectorFixture(
  context: ScenarioContext,
  dependencies: FixtureDependencies = defaultDependencies,
): Promise<ActiveSectorFixture> {
  const path = activeSectorFixturePath(context);
  const existing = readFixture(path);
  if (existing) {
    assertFixtureIdentity(context, existing);
    if (await dependencies.isActive(context, existing)) return existing;
  }

  const lockPath = `${path}.lock`;
  mkdirSync(dirname(path), { recursive: true });
  if (!tryAcquire(lockPath)) {
    for (let attempt = 0; attempt < 600; attempt++) {
      const published = readFixture(path);
      if (published) {
        assertFixtureIdentity(context, published);
        if (await dependencies.isActive(context, published)) return published;
      }
      await sleep(100);
    }
    throw new Error(`timed out waiting for active-sector fixture lock: ${lockPath}`);
  }

  try {
    const published = readFixture(path);
    if (published) {
      assertFixtureIdentity(context, published);
      if (await dependencies.isActive(context, published)) return published;
    }
    const discovered = await dependencies.discover?.(context);
    if (discovered) {
      assertFixtureIdentity(context, discovered);
      writeFixture(path, discovered);
      return discovered;
    }
    if (published && dependencies.waitUntilActive &&
      await dependencies.waitUntilActive(context, published)) return published;
    const created = await dependencies.create(context);
    assertFixtureIdentity(context, created);
    if (!await dependencies.isActive(context, created) &&
      !(dependencies.waitUntilActive &&
        await dependencies.waitUntilActive(context, created))) {
      throw new Error(`created sector ${created.sector} is not active`);
    }
    writeFixture(path, created);
    return created;
  } finally {
    rmdirSync(lockPath);
  }
}

export async function recordActiveSectorFixture(
  context: ScenarioContext,
  sector: number,
  pieceCid: string,
): Promise<ActiveSectorFixture> {
  const location = await readSectorLocation(context, sector);
  const fixture: ActiveSectorFixture = {
    generation: context.config.generation,
    provider: context.config.provider,
    sector,
    deadline: location.Deadline,
    partition: location.Partition,
    pieceCid,
    createdByRunId: context.runId,
  };
  writeFixture(activeSectorFixturePath(context), fixture);
  return fixture;
}

const defaultDependencies: FixtureDependencies = {
  isActive: sectorIsActive,
  discover: discoverActiveSector,
  waitUntilActive: waitUntilSectorIsActive,
  create: async (context) => {
    const { runDirectOnboardingNotification } = await import(
      "../scenarios/directOnboardingNotification.js"
    );
    await runDirectOnboardingNotification(context);
    const sector = Number(context.state.require("SECTOR_NUMBER"));
    const pieceCid = context.state.require("PIECE_CID");
    return recordActiveSectorFixture(context, sector, pieceCid);
  },
};

async function discoverActiveSector(
  context: ScenarioContext,
): Promise<ActiveSectorFixture | undefined> {
  const sectors = await lotusRpc<Array<{ SectorNumber?: number }>>(
    context,
    "Filecoin.StateMinerActiveSectors",
    [context.config.provider, null],
  );
  const sector = sectors
    .map((candidate) => candidate.SectorNumber)
    .filter((candidate): candidate is number => Number.isSafeInteger(candidate))
    .sort((left, right) => right - left)[0];
  if (sector === undefined) return undefined;
  const location = await readSectorLocation(context, sector);
  return {
    generation: context.config.generation,
    provider: context.config.provider,
    sector,
    deadline: location.Deadline,
    partition: location.Partition,
    pieceCid: "",
    createdByRunId: `discovered:${context.runId}`,
  };
}

async function waitUntilSectorIsActive(
  context: ScenarioContext,
  fixture: ActiveSectorFixture,
): Promise<boolean> {
  const sector = await lotusRpc<unknown | null>(
    context,
    "Filecoin.StateSectorGetInfo",
    [fixture.provider, fixture.sector, null],
  );
  if (sector === null) return false;

  const timeoutSeconds = Number(
    context.config.env.CURIO_ACTIVATION_TIMEOUT_SECONDS ?? "7200",
  );
  for (let elapsed = 0; elapsed < timeoutSeconds; elapsed += 5) {
    if (await sectorIsActive(context, fixture)) return true;
    if (elapsed === 0 || elapsed % 60 === 0) {
      console.log(`  waiting for sector ${fixture.sector} to enter the active set`);
    }
    await sleep(5000);
  }
  return false;
}

function readFixture(path: string): ActiveSectorFixture | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ActiveSectorFixture;
  } catch {
    return undefined;
  }
}

function writeFixture(path: string, fixture: ActiveSectorFixture): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.temporary.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(fixture, null, 2)}\n`);
  renameSync(temporary, path);
}

function tryAcquire(lockPath: string): boolean {
  try {
    mkdirSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function assertFixtureIdentity(
  context: ScenarioContext,
  fixture: ActiveSectorFixture,
): void {
  if (fixture.generation !== context.config.generation) {
    throw new Error(
      `fixture generation mismatch: ${fixture.generation} != ${context.config.generation}`,
    );
  }
  if (fixture.provider !== context.config.provider) {
    throw new Error(
      `fixture provider mismatch: ${fixture.provider} != ${context.config.provider}`,
    );
  }
}

async function sectorIsActive(
  context: ScenarioContext,
  fixture: ActiveSectorFixture,
): Promise<boolean> {
  const result = await lotusRpc<Array<{ SectorNumber?: number }>>(
    context,
    "Filecoin.StateMinerActiveSectors",
    [fixture.provider, null],
  );
  return result.some((sector) => sector.SectorNumber === fixture.sector);
}

async function readSectorLocation(
  context: ScenarioContext,
  sector: number,
): Promise<{ Deadline: number; Partition: number }> {
  return lotusRpc(context, "Filecoin.StateSectorPartition", [
    context.config.provider,
    sector,
    null,
  ]);
}

async function lotusRpc<T>(
  context: ScenarioContext,
  method: string,
  params: unknown[],
): Promise<T> {
  const response = await fetch(context.config.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.json() as {
    result?: T;
    error?: { message?: string };
  };
  if (!response.ok || body.result === undefined) {
    throw new Error(`${method} failed: ${body.error?.message ?? response.status}`);
  }
  return body.result;
}
