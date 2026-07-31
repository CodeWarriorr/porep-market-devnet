#!/usr/bin/env node
import { readFileSync } from "node:fs";

const [artifactPath, runtimeInput] = process.argv.slice(2);
if (!artifactPath) throw new Error("artifact path is required");

const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
const runtime = runtimeInput ?? artifact.deployedBytecode?.object;
if (typeof runtime !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(runtime)) {
  throw new Error("runtime bytecode must be explicit hex");
}

const bytes = Buffer.from(runtime.slice(2), "hex");
const references = Object.values(
  artifact.deployedBytecode?.immutableReferences ?? {},
).flat();
for (const reference of references) {
  const { start, length } = reference;
  if (
    !Number.isSafeInteger(start)
    || !Number.isSafeInteger(length)
    || start < 0
    || length < 0
    || start + length > bytes.length
  ) {
    throw new Error("artifact contains an invalid immutable reference");
  }
  bytes.fill(0, start, start + length);
}

process.stdout.write(`0x${bytes.toString("hex")}\n`);
