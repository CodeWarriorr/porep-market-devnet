import assert from "node:assert/strict";
import test from "node:test";
import { requireSufficientTokenBalance } from "../src/flows/validatorRail.js";
import { remainingProviderCapacity } from "../src/flows/provider.js";
import { settleAccountLockupAtEpoch } from "../src/flows/settlement.js";
import { activationPaymentRate, BYTES_PER_32_GIB } from "../src/expected.js";
import { nativeSweepValue } from "../src/contracts/evm.js";

test("bounded rail deposit rejects an unfunded exact amount instead of minting", () => {
  assert.doesNotThrow(() => requireSufficientTokenBalance(12n, 12n));
  assert.throws(
    () => requireSufficientTokenBalance(11n, 12n),
    /exact bounded deposit requires 12 MockUSDC, but client has 11/,
  );
});

test("provider remaining capacity accounts for both committed and accepted reservations", () => {
  assert.equal(
    remainingProviderCapacity({ availableBytes: 100n, committedBytes: 40n, pendingBytes: 30n }),
    30n,
  );
  assert.equal(
    remainingProviderCapacity({ availableBytes: 100n, committedBytes: 60n, pendingBytes: 40n }),
    0n,
  );
});

test("lockup settlement stops at the exact funded cutoff", () => {
  assert.deepEqual(
    settleAccountLockupAtEpoch(
      { funds: 30n, lockupCurrent: 10n, lockupRate: 10n, lockupLastSettledAt: 100n },
      105n,
    ),
    { funds: 30n, lockupCurrent: 30n, lockupRate: 10n, lockupLastSettledAt: 102n },
  );
});

test("bounded deposit rate is derived from the bytes activation will commit", () => {
  const monthlyPrice = 86_400_000_000n;
  assert.equal(activationPaymentRate(monthlyPrice, 2048n), 1_000_000n);
  assert.equal(activationPaymentRate(monthlyPrice, BYTES_PER_32_GIB + 1n), 2_000_000n);
});

test("native sweep reserves exactly the estimated transaction fee", () => {
  assert.equal(nativeSweepValue(100_000n, 21_000n, 2n), 58_000n);
  assert.equal(nativeSweepValue(42_000n, 21_000n, 2n), 0n);
});
