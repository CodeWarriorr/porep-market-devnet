import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

type MigrationMap = {
  sourceCommit: string;
  sourceRoot: string;
  files: Array<{ source: string; destination: string }>;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("migration map covers every original source and test file exactly once", () => {
  const map = JSON.parse(
    readFileSync(resolve(packageRoot, "migration-map.json"), "utf8"),
  ) as MigrationMap;

  assert.equal(map.sourceCommit, "62bd2e7bae2a8dbef5d78cfd19dcc8a2115bdec8");
  assert.equal(map.sourceRoot, "scripts/porep-market/v2/e2e");
  assert.equal(map.files.filter(({ source }) => source.startsWith("src/")).length, 36);
  assert.equal(map.files.filter(({ source }) => source.startsWith("test/")).length, 13);
  assert.equal(new Set(map.files.map(({ source }) => source)).size, 49);
  assert.equal(new Set(map.files.map(({ destination }) => destination)).size, 49);
  for (const row of map.files) {
    assert.equal(row.source.startsWith("/") || row.destination.startsWith("/"), false);
    assert.equal(existsSync(resolve(packageRoot, row.destination)), true, row.destination);
  }
});
