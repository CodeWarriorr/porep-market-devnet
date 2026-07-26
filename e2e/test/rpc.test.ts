import assert from "node:assert/strict";
import test from "node:test";
import {
  isActorResolutionError,
  isStableReceipt,
  retryTransientRead,
  type TxReceipt,
} from "../src/contracts/evm.js";

test("retryTransientRead retries missing revert data once after a new block", async () => {
  let reads = 0;
  let waits = 0;

  const result = await retryTransientRead(
    async () => {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error("missing revert data"), { code: "CALL_EXCEPTION", data: null });
      return true;
    },
    async () => {
      waits += 1;
    }
  );

  assert.equal(result, true);
  assert.equal(reads, 2);
  assert.equal(waits, 1);
});

test("retryTransientRead does not retry contract errors with revert data", async () => {
  let waits = 0;
  const error = Object.assign(new Error("execution reverted"), { code: "CALL_EXCEPTION", data: "0x12345678" });

  await assert.rejects(
    retryTransientRead(
      async () => {
        throw error;
      },
      async () => {
        waits += 1;
      }
    ),
    error
  );
  assert.equal(waits, 0);
});

test("isActorResolutionError recognizes Lotus actor lookup failures", () => {
  assert.equal(isActorResolutionError("resolve address t410fabc: actor not found"), true);
  assert.equal(isActorResolutionError("execution reverted: 0x12345678"), false);
});

test("stable receipt requires the same successful canonical inclusion", () => {
  const first: TxReceipt = {
    transactionHash: `0x${"1".repeat(64)}`,
    status: "0x1",
    blockHash: `0x${"2".repeat(64)}`,
    blockNumber: "0x10",
    logs: [],
  };
  assert.equal(isStableReceipt(first, { ...first }), true);
  assert.equal(isStableReceipt(first, { ...first, blockHash: `0x${"3".repeat(64)}` }), false);
  assert.equal(isStableReceipt(first, { ...first, status: "0x0" }), false);
});
