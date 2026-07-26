import assert from "node:assert/strict";
import test from "node:test";
import {
  assertZeroPaymentDidNotAdvance,
} from "../src/scenarios/terminationSettlement.js";

test("termination settlement oracle rejects zero-paid cursor advancement", () => {
  assert.doesNotThrow(() => assertZeroPaymentDidNotAdvance({
    beforeCursor: 100n,
    afterCursor: 100n,
    beforePayeeFunds: 20n,
    afterPayeeFunds: 20n,
  }));
  assert.throws(() => assertZeroPaymentDidNotAdvance({
    beforeCursor: 100n,
    afterCursor: 101n,
    beforePayeeFunds: 20n,
    afterPayeeFunds: 20n,
  }), /consumed the rail cursor/);
});
