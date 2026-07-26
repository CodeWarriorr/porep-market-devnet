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

test("Curio piece generation uses the pinned sptool path", () => {
  const piece = readFileSync(join(sourceDir, "devnet/piece.ts"), "utf8");
  const curio = readFileSync(join(sourceDir, "devnet/curio.ts"), "utf8");
  assert.match(piece, /"piece-server"/);
  assert.match(piece, /"sptool".*"toolbox".*"mk12-client".*"generate-rand-car"/s);
  assert.match(piece, /"sptool".*"toolbox".*"mk12-client".*"commp"/s);
  assert.match(piece, /"sptool".*"toolbox".*"mk20-client".*"commp"/s);
  assert.match(piece, /\/var\/lib\/curio-client\/data/);
  assert.match(curio, /assertCurioStatus/);
  assert.match(curio, /submitCurioOnboarding/);
  assert.match(curio, /buildMk20DealArgs/);
  assert.match(curio, /notificationReceiver/);
  assert.doesNotMatch(curio, /onboarding is not implemented/);
  assert.doesNotMatch(curio, /config\.toml|sed -i|restart/);
});

test("empty-database Curio startup has a bounded five-minute config wait", () => {
  const source = readFileSync(
    join(import.meta.dirname, "../../scripts/devnet-up.sh"),
    "utf8",
  );
  assert.match(source, /for _ in \{1\.\.150\}/);
  assert.match(source, /within 300 seconds/);
});

test("warm cached image build uses the documented 14 GiB free-space floor", () => {
  const repositoryRoot = join(import.meta.dirname, "../..");
  const source = readFileSync(
    join(repositoryRoot, "scripts/devnet-build.sh"),
    "utf8",
  );
  const readme = readFileSync(join(repositoryRoot, "README.md"), "utf8");
  assert.match(source, /minimum_free_bytes=\$\(\(14 \* 1024 \* 1024 \* 1024\)\)/);
  assert.match(readme, /at least 14 GiB free disk/);
});

test("required notification failure accepts Curio's exact rejection evidence", () => {
  const source = readFileSync(
    join(
      sourceDir,
      "scenarios/directOnboardingNotificationFailure.ts",
    ),
    "utf8",
  );
  assert.match(source, /sector change rejected/);
});
