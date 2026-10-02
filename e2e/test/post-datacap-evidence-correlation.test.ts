import assert from "node:assert/strict";
import test from "node:test";
import { pieceSetCommitment } from "../src/scenarios/postDatacapEvidenceCorrelation.js";

test("pieceSetCommitment commits to the PieceCID digest and padded size", () => {
  assert.equal(
    pieceSetCommitment(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
      2_097_152n,
    ),
    "0xd038419c2b3606de607ed50ac4dcad2dca1de03305fd972ad1b64f8706109371",
  );
});

test("pieceSetCommitment changes when either committed field changes", () => {
  const digest = "0x1111111111111111111111111111111111111111111111111111111111111111";
  const baseline = pieceSetCommitment(digest, 2_097_152n);

  assert.notEqual(
    pieceSetCommitment(
      "0x2111111111111111111111111111111111111111111111111111111111111111",
      2_097_152n,
    ),
    baseline,
  );
  assert.notEqual(pieceSetCommitment(digest, 4_194_304n), baseline);
});
