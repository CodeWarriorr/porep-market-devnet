import test from "node:test";
import assert from "node:assert/strict";
import { Interface } from "ethers";
import { ContractRevertError, assertCustomError, expectCustomError } from "../src/contracts/reverts.js";
import { extractRevertData } from "../src/contracts/evm.js";

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
