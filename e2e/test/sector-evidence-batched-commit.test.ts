import assert from "node:assert/strict";
import test from "node:test";
import { batchedCommitSectorCount } from "../src/scenarios/sectorEvidenceBatchedCommit.js";

test("batched commit defaults to four sectors and accepts the sixteen-sector probe", () => {
  assert.equal(batchedCommitSectorCount(undefined), 4);
  assert.equal(batchedCommitSectorCount("4"), 4);
  assert.equal(batchedCommitSectorCount("16"), 16);
});

test("batched commit rejects counts below Curio aggregation size", () => {
  for (const value of ["", "3", "4.5", "abc", "9007199254740992"]) {
    assert.throws(
      () => batchedCommitSectorCount(value),
      /SECTOR_EVIDENCE_BATCHED_COMMIT_SECTOR_COUNT must be a safe integer of at least 4/,
    );
  }
});
