import assert from "node:assert/strict";
import test from "node:test";
import { missingTokenAmount } from "../src/flows/validatorRail.js";

test("missingTokenAmount returns only the amount needed for the next deposit", () => {
  assert.equal(missingTokenAmount(4_160_000_000n, 95_040_000_000n), 90_880_000_000n);
  assert.equal(missingTokenAmount(95_040_000_000n, 95_040_000_000n), 0n);
  assert.equal(missingTokenAmount(200_000_000_000n, 95_040_000_000n), 0n);
});
