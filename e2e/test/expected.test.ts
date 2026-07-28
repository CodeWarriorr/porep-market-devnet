import assert from "node:assert/strict";
import test from "node:test";
import {
  billed32GiBUnits,
  BYTES_PER_32_GIB,
  dueAmount,
  netPayeeAmount,
  networkFee,
  EPOCHS_IN_MONTH,
  ratePerEpoch,
  settlementAmount,
} from "../src/expected.js";

const EPOCHS_IN_MONTH_LITERAL = 86_400n;
const BYTES_PER_32_GIB_LITERAL = 34_359_738_368n;

test("expected-value constants match the protocol literals", () => {
  assert.equal(EPOCHS_IN_MONTH, 86_400n);
  assert.equal(BYTES_PER_32_GIB, 34_359_738_368n);
});

test("billed32GiBUnits rounds committed bytes up to 32 GiB units", () => {
  assert.equal(billed32GiBUnits(0n), 0n);
  assert.equal(billed32GiBUnits(BYTES_PER_32_GIB_LITERAL), 1n);
  assert.equal(billed32GiBUnits(BYTES_PER_32_GIB_LITERAL + 1n), 2n);
});

test("ratePerEpoch preserves an exact monthly division", () => {
  assert.equal(ratePerEpoch(EPOCHS_IN_MONTH_LITERAL, 3n), 3n);
});

test("ratePerEpoch rounds an awkward monthly price up", () => {
  assert.equal(ratePerEpoch(EPOCHS_IN_MONTH_LITERAL + 1n, 1n), 2n);
});

test("dueAmount floors cumulative accrual and is zero before service starts", () => {
  assert.equal(dueAmount(10n, 1n, 100n, 100n), 0n);
  assert.equal(dueAmount(10n, 1n, 100n, 99n), 0n);
  assert.equal(dueAmount(10n, 1n, 100n, 100n + EPOCHS_IN_MONTH_LITERAL - 1n), 9n);
});

test("settlementAmount subtracts floored cumulative due amounts", () => {
  const price = 3n;
  const start = 0n;
  const from = EPOCHS_IN_MONTH_LITERAL / 2n;
  const to = EPOCHS_IN_MONTH_LITERAL;

  assert.equal(dueAmount(price, 1n, start, from), 1n);
  assert.equal(dueAmount(price, 1n, start, to), 3n);
  assert.equal(settlementAmount(price, 1n, start, from, to), 2n);
});

test("settlementAmount rejects a descending epoch window", () => {
  assert.throws(
    () => settlementAmount(1n, 1n, 0n, 2n, 1n),
    /settlement end epoch must not be before start epoch/,
  );
});

test("network fee rounds gross settlement up at one two-hundredth", () => {
  assert.equal(networkFee(1n), 1n);
  assert.equal(networkFee(200n), 1n);
  assert.equal(networkFee(201n), 2n);
});

test("net payee amount deducts the independently computed network fee", () => {
  assert.equal(netPayeeAmount(201n), 199n);
});
