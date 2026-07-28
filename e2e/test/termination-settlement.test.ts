import test from "node:test";
import { assertExactSettlementAccounting } from "../src/flows/settlement.js";

test("termination zero-payment outcome has no observable transfer", () => {
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
