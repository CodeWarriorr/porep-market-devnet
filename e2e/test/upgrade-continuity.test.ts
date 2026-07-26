import assert from "node:assert/strict";
import test from "node:test";
import { assertUpgradeContinuity } from "../src/scenarios/upgradeContinuity.js";

test("upgrade continuity requires stable proxies and changed requested implementations", () => {
  const before = record(0, "1");
  assert.doesNotThrow(() =>
    assertUpgradeContinuity(before, record(1, "2"), ["PoRepMarket"])
  );
  assert.throws(() =>
    assertUpgradeContinuity(before, record(1, "1"), ["PoRepMarket"]),
  /implementation did not change/);
  const moved = record(1, "2");
  moved.contracts.PoRepMarket!.address = address("9");
  assert.throws(() =>
    assertUpgradeContinuity(before, moved, ["PoRepMarket"]));
});

function record(revision: number, implementation: string) {
  const stable = { value: "stable" };
  return {
    deploymentId: "deployment-test",
    deploymentRevision: revision,
    contracts: {
      PoRepMarket: {
        address: address("1"),
        implementation: address(implementation),
        kind: "uups",
      },
      PoRepMarketImplementation: {
        address: address(implementation),
        kind: "direct",
      },
    },
    deal: stable,
    dealData: stable,
    dealTerms: stable,
    dealCapacity: stable,
    dealPayment: stable,
    dealService: stable,
    evidenceStatus: stable,
    rail: stable,
  };
}

function address(value: string): string {
  return `0x${value.repeat(40)}`;
}
