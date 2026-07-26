import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore } from "../src/state.js";

test("StateStore persists and reloads run values", () => {
  const dir = mkdtempSync(join(tmpdir(), "porep-e2e-state-"));
  const path = join(dir, "state.json");
  const state = new StateStore(path);

  state.set("dealId", "7");
  state.set("railId", "11");

  const reloaded = new StateStore(path);
  assert.equal(reloaded.require("dealId"), "7");
  assert.equal(reloaded.require("railId"), "11");
  assert.match(readFileSync(path, "utf8"), /"dealId": "7"/);
});

test("StateStore.require fails with the missing key name", () => {
  const dir = mkdtempSync(join(tmpdir(), "porep-e2e-state-"));
  const state = new StateStore(join(dir, "state.json"));

  assert.throws(() => state.require("dealId"), /missing state key: dealId/);
});
