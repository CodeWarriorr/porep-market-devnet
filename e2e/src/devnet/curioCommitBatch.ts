import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenarioContext } from "../runtime.js";
import { runRequired, sleep } from "../shell.js";
import { dockerExec } from "./docker.js";

const CONFIG_LAYER = "market";
const TEST_TIMEOUT_SECONDS = 2 * 60 * 60;
const TEST_TIMEOUT = "2h0m0s";
const TEST_SLACK = "0s";

type EffectiveCommitBatchConfig = {
  timeoutSeconds: number;
  slackSeconds: number;
  maxBatch: number;
  maxQueueDealSector: number;
};

type CommitBatchJournal = {
  version: 1;
  generation: string;
  layer: typeof CONFIG_LAYER;
  baselineHex: string;
  temporaryHex: string;
  baselineHash: string;
  temporaryHash: string;
  baselineEffective: EffectiveCommitBatchConfig;
  requestedMaxBatch: number;
  status: "prepared" | "applied" | "restored";
};

export type CurioCommitBatchLease = {
  requestedMaxBatch: number;
  restore: () => Promise<void>;
};

export function buildCurioCommitBatchOverride(
  baseline: string,
  maxBatch: number,
): string {
  if (!Number.isSafeInteger(maxBatch) || maxBatch < 4) {
    throw new Error("Curio commit batch size must be a safe integer of at least 4");
  }
  let lines = baseline.split("\n");
  lines = replaceSectionValues(lines, "Ingest", new Map([
    ["MaxQueueDealSector", `  MaxQueueDealSector = ${maxBatch}`],
  ]));
  const sectionStart = lines.findIndex((line) => /^\s*\[Batching\.Commit\]\s*$/.test(line));
  if (sectionStart < 0) throw new Error("Curio market Batching.Commit section is missing");
  const sectionEndOffset = lines.slice(sectionStart + 1).findIndex((line) =>
    /^\s*\[[^[]/.test(line));
  const sectionEnd = sectionEndOffset < 0 ? lines.length : sectionStart + 1 + sectionEndOffset;
  const indent = lines
    .slice(sectionStart + 1, sectionEnd)
    .find((line) => /^\s*(?:Timeout|Slack|MaxBatch)\s*=/.test(line))
    ?.match(/^\s*/)?.[0] ?? "    ";
  const replacements = new Map([
    ["Timeout", `${indent}Timeout = "${TEST_TIMEOUT}"`],
    ["Slack", `${indent}Slack = "${TEST_SLACK}"`],
    ["MaxBatch", `${indent}MaxBatch = ${maxBatch}`],
  ]);
  const seen = new Set<string>();
  const section = lines.slice(sectionStart + 1, sectionEnd).map((line) => {
    const key = line.match(/^\s*(Timeout|Slack|MaxBatch)\s*=/)?.[1];
    if (!key) return line;
    seen.add(key);
    return replacements.get(key)!;
  });
  let insertionIndex = section.length;
  while (insertionIndex > 0 && section[insertionIndex - 1]!.trim().length === 0) {
    insertionIndex--;
  }
  const missing = ["Timeout", "Slack", "MaxBatch"]
    .filter((key) => !seen.has(key))
    .map((key) => replacements.get(key)!);
  section.splice(insertionIndex, 0, ...missing);
  return [...lines.slice(0, sectionStart + 1), ...section, ...lines.slice(sectionEnd)].join("\n");
}

export function parseCurioCommitBatchConfig(value: string): EffectiveCommitBatchConfig {
  const section = batchingCommitSection(value);
  const ingest = namedSection(value, "Ingest");
  return {
    timeoutSeconds: parseDuration(activeValue(section, "Timeout") ?? "1h0m0s"),
    slackSeconds: parseDuration(activeValue(section, "Slack") ?? "1h0m0s"),
    maxBatch: parseNonNegativeInteger(activeValue(section, "MaxBatch") ?? "0", "MaxBatch"),
    maxQueueDealSector: parseNonNegativeInteger(
      activeValue(ingest, "MaxQueueDealSector") ?? "8",
      "MaxQueueDealSector",
    ),
  };
}

export function decideCurioCommitBatchRecovery(
  liveHash: string,
  baselineHash: string,
  temporaryHash: string,
): "already-restored" | "restore" | "conflict" {
  if (liveHash === baselineHash) return "already-restored";
  if (liveHash === temporaryHash) return "restore";
  return "conflict";
}

export async function recoverSectorEvidenceCommitBatchConfig(
  context: ScenarioContext,
): Promise<void> {
  const journal = readJournal(context);
  if (!journal || journal.status === "restored") return;
  if (journal.version !== 1 || journal.layer !== CONFIG_LAYER) {
    throw new Error("sector-evidence Curio batch journal has an unsupported format");
  }
  const live = readMarketLayer(context);
  const decision = decideCurioCommitBatchRecovery(
    sha256(live),
    journal.baselineHash,
    journal.temporaryHash,
  );
  if (decision === "conflict") {
    throw new Error("sector-evidence Curio batch recovery found a human-edited market layer; refusing to overwrite it");
  }
  if (decision === "restore") {
    writeMarketLayer(context, decodeHex(journal.baselineHex));
    restartCurio(context);
    await waitForCurioHealthy(context);
    assertEffectiveConfig(context, journal.baselineEffective);
  }
  writeJournal(context, { ...journal, status: "restored" });
}

export async function applySectorEvidenceCommitBatchConfig(
  context: ScenarioContext,
  maxBatch: number,
): Promise<CurioCommitBatchLease> {
  await recoverSectorEvidenceCommitBatchConfig(context);
  const baseline = readMarketLayer(context);
  const temporary = buildCurioCommitBatchOverride(baseline, maxBatch);
  const journal: CommitBatchJournal = {
    version: 1,
    generation: context.config.generation,
    layer: CONFIG_LAYER,
    baselineHex: Buffer.from(baseline).toString("hex"),
    temporaryHex: Buffer.from(temporary).toString("hex"),
    baselineHash: sha256(baseline),
    temporaryHash: sha256(temporary),
    baselineEffective: readEffectiveConfig(context),
    requestedMaxBatch: maxBatch,
    status: "prepared",
  };
  writeJournal(context, journal);
  try {
    writeMarketLayer(context, temporary);
    writeJournal(context, { ...journal, status: "applied" });
    restartCurio(context);
    await waitForCurioHealthy(context);
    assertEffectiveConfig(context, {
      timeoutSeconds: TEST_TIMEOUT_SECONDS,
      slackSeconds: 0,
      maxBatch,
      maxQueueDealSector: maxBatch,
    });
  } catch (error) {
    await recoverSectorEvidenceCommitBatchConfig(context);
    throw error;
  }

  let restored = false;
  return {
    requestedMaxBatch: maxBatch,
    restore: async () => {
      if (restored) return;
      await recoverSectorEvidenceCommitBatchConfig(context);
      restored = true;
    },
  };
}

function readMarketLayer(context: ScenarioContext): string {
  const hex = dockerExec(context, "yugabyte", [
    "ysqlsh", "-h", "yugabyte", "-U", "yugabyte", "-d", "yugabyte",
    "-At", "-c",
    `select encode(convert_to(config, 'UTF8'), 'hex') from curio.harmony_config where title='${CONFIG_LAYER}'`,
  ]).trim();
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error(`Curio ${CONFIG_LAYER} config layer is missing or invalid`);
  }
  return decodeHex(hex);
}

function writeMarketLayer(context: ScenarioContext, value: string): void {
  dockerExec(context, "curio", [
    "bash", "-ec",
    `printf '%s' "$1" | base64 -d | curio config set --title ${CONFIG_LAYER} >/dev/null`,
    "curio-batch-config",
    Buffer.from(value).toString("base64"),
  ]);
  if (sha256(readMarketLayer(context)) !== sha256(value)) {
    throw new Error(`Curio ${CONFIG_LAYER} config write did not preserve the requested TOML`);
  }
}

function restartCurio(context: ScenarioContext): void {
  runRequired("docker", [
    "compose",
    "--env-file", join(context.projectRoot, ".runtime/devnet/compose.env"),
    "--project-name", "porep-market-curio-devnet",
    "--file", join(context.projectRoot, "docker/compose.curio-devnet.yaml"),
    "restart", "curio",
  ], context.projectRoot);
}

async function waitForCurioHealthy(context: ScenarioContext): Promise<void> {
  for (let attempt = 0; attempt < 90; attempt++) {
    const status = runRequired(
      "docker",
      ["inspect", "--format", "{{if .State.Health}}{{.State.Health.Status}}{{end}}", "porep-market-curio-devnet-curio-1"],
      context.projectRoot,
    );
    if (status === "healthy") return;
    await sleep(2_000);
  }
  throw new Error("Curio did not become healthy after applying commit batching config");
}

function readEffectiveConfig(context: ScenarioContext): EffectiveCommitBatchConfig {
  const output = dockerExec(context, "curio", [
    "bash", "-ec",
    "curio config interpret --layers seal,post,market,gui | awk '" +
      "/^[[:space:]]*\\[Ingest\\]/{section=\"ingest\"; print; next} " +
      "/^[[:space:]]*\\[Batching.Commit\\]/{section=\"commit\"; print; next} " +
      "section && /^[[:space:]]*\\[/{section=\"\"} " +
      "section==\"ingest\" && /^[[:space:]]*MaxQueueDealSector[[:space:]]*=/{print} " +
      "section==\"commit\" && /^[[:space:]]*(Timeout|Slack|MaxBatch)[[:space:]]*=/{print}'",
  ]);
  return parseCurioCommitBatchConfig(output);
}

function assertEffectiveConfig(
  context: ScenarioContext,
  expected: EffectiveCommitBatchConfig,
): void {
  const actual = readEffectiveConfig(context);
  if (
    actual.timeoutSeconds !== expected.timeoutSeconds
    || actual.slackSeconds !== expected.slackSeconds
    || actual.maxBatch !== expected.maxBatch
    || actual.maxQueueDealSector !== expected.maxQueueDealSector
  ) {
    throw new Error(`Curio effective commit batching mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function batchingCommitSection(value: string): string {
  return namedSection(value, "Batching.Commit");
}

function namedSection(value: string, name: string): string {
  const lines = value.split("\n");
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const start = lines.findIndex((line) => new RegExp(`^\\s*\\[${escaped}\\]\\s*$`).test(line));
  if (start < 0) throw new Error(`Curio ${name} section is missing`);
  const endOffset = lines.slice(start + 1).findIndex((line) => /^\s*\[[^[]/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join("\n");
}

function replaceSectionValues(
  lines: string[],
  sectionName: string,
  replacements: Map<string, string>,
): string[] {
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionStart = lines.findIndex((line) => new RegExp(`^\\s*\\[${escaped}\\]\\s*$`).test(line));
  if (sectionStart < 0) throw new Error(`Curio market ${sectionName} section is missing`);
  const sectionEndOffset = lines.slice(sectionStart + 1).findIndex((line) => /^\s*\[[^[]/.test(line));
  const sectionEnd = sectionEndOffset < 0 ? lines.length : sectionStart + 1 + sectionEndOffset;
  const section = lines.slice(sectionStart + 1, sectionEnd);
  const seen = new Set<string>();
  for (let index = 0; index < section.length; index++) {
    const key = section[index]!.match(/^\s*([A-Za-z0-9]+)\s*=/)?.[1];
    if (!key || !replacements.has(key)) continue;
    section[index] = replacements.get(key)!;
    seen.add(key);
  }
  let insertionIndex = section.length;
  while (insertionIndex > 0 && section[insertionIndex - 1]!.trim().length === 0) insertionIndex--;
  section.splice(
    insertionIndex,
    0,
    ...[...replacements].filter(([key]) => !seen.has(key)).map(([, line]) => line),
  );
  return [...lines.slice(0, sectionStart + 1), ...section, ...lines.slice(sectionEnd)];
}

function activeValue(section: string, key: string): string | undefined {
  return section.match(new RegExp(`^\\s*${key}\\s*=\\s*"?([^"#\\s]+)"?\\s*$`, "m"))?.[1];
}

function parseDuration(value: string): number {
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || match[0].length === 0) throw new Error(`invalid Curio duration ${value}`);
  return Number(match[1] ?? 0) * 3_600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
}

function parseNonNegativeInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`invalid Curio ${name} ${value}`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`invalid Curio ${name} ${value}`);
  return number;
}

function journalPath(context: ScenarioContext): string {
  return join(context.projectRoot, ".runtime", "sector-evidence-curio-batch-config.json");
}

function readJournal(context: ScenarioContext): CommitBatchJournal | undefined {
  try {
    return JSON.parse(readFileSync(journalPath(context), "utf8")) as CommitBatchJournal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("sector-evidence Curio batch journal is invalid");
  }
}

function writeJournal(context: ScenarioContext, journal: CommitBatchJournal): void {
  const path = journalPath(context);
  mkdirSync(join(path, ".."), { recursive: true });
  const temporary = `${path}.temporary.${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`);
  renameSync(temporary, path);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeHex(value: string): string {
  return Buffer.from(value, "hex").toString("utf8");
}
