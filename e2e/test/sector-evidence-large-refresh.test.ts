import test from "node:test";
import assert from "node:assert/strict";
import { largeSectorCount } from "../src/scenarios/sectorEvidenceLargeRefresh.js";

test("large sector refresh defaults to sixteen sectors", () => {
  assert.equal(largeSectorCount(undefined), 16);
});

test("large sector refresh accepts an explicit positive whole-sector count", () => {
  assert.equal(largeSectorCount("3"), 3);
  assert.equal(largeSectorCount("32"), 32);
  assert.equal(largeSectorCount("89"), 89);
});

test("large sector refresh rejects counts that cannot produce both refresh batches", () => {
  for (const value of ["", "2", "16.5", "abc", "9007199254740992"]) {
    assert.throws(
      () => largeSectorCount(value),
      /SECTOR_EVIDENCE_LARGE_SECTOR_COUNT must be a safe integer of at least 3/,
    );
  }
});
