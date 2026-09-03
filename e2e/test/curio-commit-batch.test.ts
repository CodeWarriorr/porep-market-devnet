import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCurioCommitBatchOverride,
  decideCurioCommitBatchRecovery,
  parseCurioCommitBatchConfig,
} from "../src/devnet/curioCommitBatch.js";

const MARKET_CONFIG = `[Subsystems]
  EnableDealMarket = true

[Ingest]
  MaxDealWaitTime = "0h0m30s"

[Batching]
  [Batching.PreCommit]
    Timeout = "0h0m5s"
  [Batching.Commit]
    Timeout = "0h0m5s"
    Slack = "1h0m0s"
`;

test("commit batch override changes only the existing commit batching section", () => {
  const temporary = buildCurioCommitBatchOverride(MARKET_CONFIG, 16);

  assert.equal(temporary, `[Subsystems]
  EnableDealMarket = true

[Ingest]
  MaxDealWaitTime = "0h0m30s"
  MaxQueueDealSector = 16

[Batching]
  [Batching.PreCommit]
    Timeout = "0h0m5s"
  [Batching.Commit]
    Timeout = "2h0m0s"
    Slack = "0s"
    MaxBatch = 16
`);
  assert.deepEqual(parseCurioCommitBatchConfig(temporary), {
    timeoutSeconds: 7_200,
    slackSeconds: 0,
    maxBatch: 16,
    maxQueueDealSector: 16,
  });
});

test("commit batch override rejects ambiguous or unsafe input", () => {
  assert.throws(
    () => buildCurioCommitBatchOverride("[Subsystems]\n", 4),
    /Ingest section is missing/,
  );
  assert.throws(
    () => buildCurioCommitBatchOverride(MARKET_CONFIG, 3),
    /at least 4/,
  );
});

test("interrupted config recovery restores only the exact recorded override", () => {
  assert.equal(decideCurioCommitBatchRecovery("baseline", "baseline", "temporary"), "already-restored");
  assert.equal(decideCurioCommitBatchRecovery("temporary", "baseline", "temporary"), "restore");
  assert.equal(decideCurioCommitBatchRecovery("human-edit", "baseline", "temporary"), "conflict");
});
