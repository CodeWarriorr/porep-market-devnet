import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import {
  ContractRevertError,
  assertCustomError,
  expectCustomError,
  expectRevertOnSend,
} from "../src/contracts/reverts.js";
import {
  assertMinedTransactionEnvelope,
  extractAsyncTxHash,
  extractRevertData,
  revertDataFromTransactionTrace,
  type TxReceipt,
} from "../src/contracts/evm.js";

const errorAbi = [
  {
    type: "error",
    name: "CallerIsNotPoRepMarket",
    inputs: [{ name: "caller", type: "address" }]
  }
];

test("assertCustomError accepts the expected custom-error revert data", () => {
  const data = new Interface(errorAbi).encodeErrorResult("CallerIsNotPoRepMarket", [
    "0x000000000000000000000000000000000000bEEF"
  ]);

  assert.doesNotThrow(() =>
    assertCustomError(new ContractRevertError(data), errorAbi, "CallerIsNotPoRepMarket")
  );
});

test("assertCustomError rejects an unrelated revert", () => {
  assert.throws(
    () => assertCustomError(new ContractRevertError("0xdeadbeef"), errorAbi, "CallerIsNotPoRepMarket"),
    /expected CallerIsNotPoRepMarket/
  );
});

test("assertCustomError rejects error-name text without ABI-decodable revert data", () => {
  assert.throws(
    () => assertCustomError(new Error("RPC wrapper failed while decoding CallerIsNotPoRepMarket"), errorAbi, "CallerIsNotPoRepMarket"),
    /did not contain contract revert data/
  );
});

test("expectCustomError returns the matching error and rejects unexpected success", async () => {
  const data = new Interface(errorAbi).encodeErrorResult("CallerIsNotPoRepMarket", [
    "0x000000000000000000000000000000000000bEEF"
  ]);
  const expected = new ContractRevertError(data);

  assert.equal((await expectCustomError(async () => { throw expected; }, errorAbi, "CallerIsNotPoRepMarket")).name, "CallerIsNotPoRepMarket");
  await assert.rejects(
    () => expectCustomError(async () => undefined, errorAbi, "CallerIsNotPoRepMarket"),
    /expected CallerIsNotPoRepMarket, but the call succeeded/
  );
});

test("expectRevertOnSend requires a mined revert and returns its decoded custom error", async () => {
  const data = new Interface(errorAbi).encodeErrorResult("CallerIsNotPoRepMarket", [
    "0x000000000000000000000000000000000000bEEF"
  ]);
  const receipt: TxReceipt = {
    transactionHash: `0x${"1".repeat(64)}`,
    status: "0x0",
    blockHash: `0x${"2".repeat(64)}`,
    blockNumber: "0x10",
    logs: [],
  };
  const calls: unknown[][] = [];
  const evm = {
    async sendWithPrivateKeyAllowRevert(...args: unknown[]) {
      calls.push(args);
      return { receipt, revertData: data };
    },
  };

  const error = await expectRevertOnSend(
    evm,
    "test-private-key",
    "0x000000000000000000000000000000000000dEaD",
    "refreshEvidenceStatus(uint256,bytes)",
    [7n, "0x"],
    errorAbi,
    "CallerIsNotPoRepMarket",
  );

  assert.equal(error.name, "CallerIsNotPoRepMarket");
  assert.equal(error.args[0], "0x000000000000000000000000000000000000bEEF");
  assert.deepEqual(calls, [[
    "test-private-key",
    "0x000000000000000000000000000000000000dEaD",
    "refreshEvidenceStatus(uint256,bytes)",
    [7n, "0x"],
  ]]);
});

test("expectRevertOnSend rejects a successful receipt or missing mined revert data", async () => {
  const receipt: TxReceipt = {
    transactionHash: `0x${"1".repeat(64)}`,
    status: "0x1",
    blockHash: `0x${"2".repeat(64)}`,
    blockNumber: "0x10",
    logs: [],
  };
  const evm = {
    async sendWithPrivateKeyAllowRevert() {
      return { receipt };
    },
  };

  await assert.rejects(
    () => expectRevertOnSend(
      evm,
      "test-private-key",
      "0x000000000000000000000000000000000000dEaD",
      "refreshEvidenceStatus(uint256,bytes)",
      [7n, "0x"],
      errorAbi,
      "CallerIsNotPoRepMarket",
    ),
    /expected CallerIsNotPoRepMarket, but tx .* succeeded/,
  );

  receipt.status = "0x0";
  await assert.rejects(
    () => expectRevertOnSend(
      evm,
      "test-private-key",
      "0x000000000000000000000000000000000000dEaD",
      "refreshEvidenceStatus(uint256,bytes)",
      [7n, "0x"],
      errorAbi,
      "CallerIsNotPoRepMarket",
    ),
    /tx .* was mined and reverted, but no revert data was recovered/,
  );
});

test("extractRevertData reads only explicit RPC revert-data fields", () => {
  assert.equal(
    extractRevertData('Error: execution reverted, data: "0xdeadbeef0001"'),
    "0xdeadbeef0001"
  );
  assert.equal(
    extractRevertData("RPC failed for 0x000000000000000000000000000000000000dEaD"),
    undefined
  );
});

test("async broadcast output must contain exactly one transaction hash", () => {
  const transactionHash = `0x${"1".repeat(64)}`;

  assert.equal(extractAsyncTxHash(transactionHash), transactionHash);
  assert.equal(extractAsyncTxHash(JSON.stringify(transactionHash)), transactionHash);
  assert.equal(extractAsyncTxHash(`warning: unrelated ${transactionHash}`), undefined);
});

test("mined transaction evidence must match the broadcast hash and requested envelope", () => {
  const transactionHash = `0x${"1".repeat(64)}`;
  const blockHash = `0x${"2".repeat(64)}`;
  const from = "0x000000000000000000000000000000000000bEEF";
  const to = "0x000000000000000000000000000000000000dEaD";
  const input = "0x12345678";
  const receipt: TxReceipt = {
    transactionHash,
    status: "0x0",
    blockHash,
    blockNumber: "0x10",
    logs: [],
  };
  const transaction = {
    hash: transactionHash,
    from,
    to,
    input,
    blockHash,
    blockNumber: "0x10",
  };

  assert.doesNotThrow(() =>
    assertMinedTransactionEnvelope(transactionHash, receipt, transaction, { from, to, input })
  );
  assert.throws(
    () => assertMinedTransactionEnvelope(
      transactionHash,
      receipt,
      { ...transaction, hash: `0x${"3".repeat(64)}` },
      { from, to, input },
    ),
    /returned transaction hash does not match broadcast hash/,
  );
  assert.throws(
    () => assertMinedTransactionEnvelope(
      transactionHash,
      receipt,
      { ...transaction, input: "0xdeadbeef" },
      { from, to, input },
    ),
    /mined transaction input does not match requested input/,
  );
});

test("revert data comes from the canonical root trace for the exact transaction", () => {
  const transactionHash = `0x${"1".repeat(64)}`;
  const blockHash = `0x${"2".repeat(64)}`;
  const receipt: TxReceipt = {
    transactionHash,
    status: "0x0",
    blockHash,
    blockNumber: "0x10",
    logs: [],
  };
  const root = {
    type: "call",
    error: "Reverted",
    traceAddress: [],
    result: { output: "0xdeadbeef" },
    blockHash,
    blockNumber: 16,
    transactionHash,
  };

  assert.equal(revertDataFromTransactionTrace(transactionHash, receipt, [root]), "0xdeadbeef");
  assert.throws(
    () => revertDataFromTransactionTrace(
      transactionHash,
      receipt,
      [{ ...root, transactionHash: `0x${"3".repeat(64)}` }],
    ),
    /trace transaction hash does not match broadcast hash/,
  );
});
