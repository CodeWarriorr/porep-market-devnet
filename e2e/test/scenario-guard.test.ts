import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const sourceDir = join(import.meta.dirname, "../src");

function sourcesUnder(...roots: string[]): Array<{ name: string; source: string }> {
  return roots.flatMap((root) => {
    const directory = join(sourceDir, root);
    return readdirSync(directory, { recursive: true, encoding: "utf8" })
      .filter((name) => name.endsWith(".ts"))
      .map((name) => ({
        name: join(root, name),
        source: readFileSync(join(directory, name), "utf8"),
      }));
  });
}

test("TypeScript scenarios do not delegate state-changing flows to setup scripts", () => {
  for (const { name, source } of sourcesUnder("flows", "scenarios")) {
    for (const pattern of [/scriptStep\(/, /command:\s*"bash"/, /\/steps\//, /\/setup\/0[478]_/]) {
      assert.doesNotMatch(source, pattern, `${name} must keep scenario changes in TypeScript`);
    }
  }
});

test("provider and scenario code has no Boost runtime dependency", () => {
  for (const { name, source } of sourcesUnder("devnet", "flows", "scenarios")) {
    assert.doesNotMatch(source, /\bboost(?:d|x|er)?\b/i, `${name} still references Boost`);
    assert.doesNotMatch(source, /docker\/devnet\/docker-compose\.yaml/, `${name} uses the old Compose file`);
  }
});
