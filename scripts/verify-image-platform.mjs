#!/usr/bin/env node

const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

class ValidationError extends Error {}

function reject(reason) {
  throw new ValidationError(reason);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCompatiblePlatform(platform, architecture) {
  if (!isRecord(platform) || platform.os !== "linux" || platform.architecture !== architecture) {
    return false;
  }
  if (architecture === "arm64") {
    return platform.variant === undefined || platform.variant === "v8";
  }
  return platform.variant === undefined;
}

async function readBoundedStdin() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) {
      reject("OCI index exceeds input limit");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const [architecture, expectedDigest, ...extraArguments] = process.argv.slice(2);
  if (
    extraArguments.length !== 0
    || !["amd64", "arm64"].includes(architecture)
    || !DIGEST_PATTERN.test(expectedDigest ?? "")
  ) {
    reject("invalid validator arguments");
  }

  let index;
  try {
    index = JSON.parse(await readBoundedStdin());
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    reject("invalid OCI index JSON");
  }
  if (!isRecord(index) || !Array.isArray(index.manifests)) {
    reject("OCI index has no manifest list");
  }

  const compatibleChildren = index.manifests.filter(
    (manifest) => isRecord(manifest) && isCompatiblePlatform(manifest.platform, architecture),
  );
  if (compatibleChildren.length !== 1) {
    reject("expected exactly one compatible manifest child");
  }
  if (compatibleChildren[0].digest !== expectedDigest) {
    reject("compatible manifest digest does not match lock");
  }
}

main().catch((error) => {
  const reason = error instanceof ValidationError ? error.message : "unexpected validator error";
  process.stderr.write(`image platform validation failed: ${reason}\n`);
  process.exitCode = 1;
});
