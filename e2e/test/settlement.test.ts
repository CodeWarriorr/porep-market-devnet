import test from "node:test";
import assert from "node:assert/strict";
import {
  assertExactSettlementAccounting,
  assertSettlementAccountingMatchesEvent,
  expectedSharedPayerLockupRate
} from "../src/flows/settlement.js";

test("shared payer lockup assertion is relative to the scenario baseline", () => {
  assert.equal(expectedSharedPayerLockupRate(1_000_000n, 1_000_000n, 1_000_000n), 3_000_000n);
});

test("settlement accounting treats payer delta as gross and payee delta as net", () => {
  assertSettlementAccountingMatchesEvent({
    payerFundsDelta: 71_000_000n,
    payeeFundsDelta: 70_645_000n,
    totalSettledAmount: 71_000_000n,
    totalNetPayeeAmount: 70_645_000n,
    operatorCommission: 0n,
    networkFee: 355_000n
  });
});

test("exact settlement accounting checks independent gross, fee, and net expectations", () => {
  assertExactSettlementAccounting({
    payerFundsDelta: 201n,
    payeeFundsDelta: 199n,
    totalSettledAmount: 201n,
    totalNetPayeeAmount: 199n,
    operatorCommission: 0n,
    networkFee: 2n,
    expectedGross: 201n,
    expectedNetworkFee: 2n,
    expectedNetPayee: 199n,
  });
  assert.throws(() => assertExactSettlementAccounting({
    payerFundsDelta: 201n,
    payeeFundsDelta: 199n,
    totalSettledAmount: 201n,
    totalNetPayeeAmount: 199n,
    operatorCommission: 0n,
    networkFee: 2n,
    expectedGross: 201n,
    expectedNetworkFee: 1n,
    expectedNetPayee: 199n,
  }), /RailSettled network fee/);
});

test("zero-payment settlement accounting keeps all observable amounts at zero", () => {
  assertExactSettlementAccounting({
    payerFundsDelta: 0n,
    payeeFundsDelta: 0n,
    totalSettledAmount: 0n,
    totalNetPayeeAmount: 0n,
    operatorCommission: 0n,
    networkFee: 0n,
    expectedGross: 0n,
    expectedNetworkFee: 0n,
    expectedNetPayee: 0n,
  });
});
