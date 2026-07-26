import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

test("CLI completes strict preflight before scenario dispatch", () => {
  const source = readFileSync(join(import.meta.dirname, "../src/cli.ts"), "utf8");
  const collect = source.indexOf("collectPreflightFacts(context)");
  const assertReady = source.indexOf("assertPreflightFacts(facts)");
  const dispatch = source.indexOf("resolveScenario(scenario)");
  assert.ok(collect >= 0);
  assert.ok(assertReady > collect);
  assert.ok(dispatch > assertReady);
  assert.match(source, /\.runtime\/runs|config\.runRoot/);
  assert.match(source, /finally/);
  assert.match(source, /writeRunSummary\(\s*context,\s*failure === undefined \? "passed" : "failed"/s);
  assert.doesNotMatch(source, /\.env(?:["']|\s+file)|boost|docker exec/i);
});

test("matrix CLI runs every registered scenario sequentially and writes a durable report", () => {
  const sourcePath = join(import.meta.dirname, "../src/matrix.ts");
  assert.equal(existsSync(sourcePath), true, "matrix runner must exist");
  const source = readFileSync(sourcePath, "utf8");
  assert.match(source, /resolveSuite/);
  assert.match(source, /for \(const .* of selectedScenarios/);
  assert.match(source, /matrix-report\.json/);
  assert.match(source, /startedAt/);
  assert.match(source, /completedAt/);
  assert.match(source, /summaryPath/);
  assert.match(source, /SCENARIO_RUN_DIR/);
  assert.doesNotMatch(source, /matchAll\(\/Run summary/);
  assert.match(source, /logPath/);
  assert.match(source, /stateIds/);
  assert.match(source, /process\.exitCode = 1/);
});
