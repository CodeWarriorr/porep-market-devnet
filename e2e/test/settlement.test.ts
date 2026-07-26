import test from "node:test";
import assert from "node:assert/strict";
import {
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
