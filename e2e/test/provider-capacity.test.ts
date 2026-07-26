import assert from "node:assert/strict";
import test from "node:test";
import {
  capacityFloor,
  offerPaymentNeedsUpdate,
} from "../src/flows/provider.js";

test("provider capacity setup never erases capacity already in use", () => {
  assert.equal(
    capacityFloor(
      { availableBytes: 100n, committedBytes: 80n, pendingBytes: 30n },
      20n,
    ),
    130n,
  );
  assert.equal(
    capacityFloor(
      { availableBytes: 1_000n, committedBytes: 80n, pendingBytes: 30n },
      20n,
    ),
    1_000n,
  );
});

test("provider setup skips an already matching offer payment row", () => {
  assert.equal(offerPaymentNeedsUpdate(true, 10n, 10n), false);
  assert.equal(offerPaymentNeedsUpdate(false, 10n, 10n), true);
  assert.equal(offerPaymentNeedsUpdate(true, 9n, 10n), true);
});
