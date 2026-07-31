import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import {
  isFvmContractSenderPrevalidation,
  replaceDataCapBatchOperatorData,
} from "../src/flows/datacap.js";
import { assertPartialEvidenceRefreshPersistence } from "../src/flows/settlement.js";

const dataCapAbi = [
  "function submitDataCapBatch(((bytes),(bytes,bool),bytes) params,uint256 dealId)",
];

test("replaceDataCapBatchOperatorData preserves a valid TransferParams envelope", () => {
  const iface = new Interface(dataCapAbi);
  const original = iface.encodeFunctionData("submitDataCapBatch", [
    [["0x06"], ["0x0100", false], "0x828080"],
    42n,
  ]);

  const replaced = replaceDataCapBatchOperatorData(dataCapAbi, original, "0x8180");
  const decoded = iface.decodeFunctionData("submitDataCapBatch", replaced);

  assert.equal(decoded[0][0][0], "0x06");
  assert.equal(decoded[0][1][0], "0x0100");
  assert.equal(decoded[0][1][1], false);
  assert.equal(decoded[0][2], "0x8180");
  assert.equal(decoded[1], 42n);
});

test("FVM contract-sender prevalidation is skipped only for the exact empty-data error", () => {
  assert.equal(isFvmContractSenderPrevalidation('SysErrSenderInvalid(1), data: "0x"'), true);
  assert.equal(isFvmContractSenderPrevalidation("SysErrSenderInvalid(1) data 0x"), true);
  assert.equal(isFvmContractSenderPrevalidation("SysErrSenderInvalid(1) data 0x1234"), false);
  assert.equal(isFvmContractSenderPrevalidation("SenderInvalid(1) data 0x"), false);
});

test("partial refresh keeps the prior completed status while exposing preview progress", () => {
  const previous = {
    activeCoveredBytes: 0n,
    lastEvidenceRefreshEpoch: 0n,
    reasonCode: 0n,
    result: 0n,
    checkedClaims: 0n,
    totalClaims: 2n,
  };
  const preview = {
    activeCoveredBytes: 2_097_152n,
    lastEvidenceRefreshEpoch: 0n,
    reasonCode: 0n,
    result: 10n,
    checkedClaims: 1n,
    totalClaims: 2n,
  };

  assertPartialEvidenceRefreshPersistence(
    previous,
    preview,
    { ...previous, checkedClaims: 1n, totalClaims: 2n },
    4_194_304n,
    1n,
  );
});
