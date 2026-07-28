import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveScenario,
  resolveSuite,
  scenarioDefinitions,
  scenarioNames,
} from "../src/scenarios/registry.js";

test("scenario registry exposes every supported CLI scenario", () => {
  assert.deepEqual(scenarioNames, [
    "accepted-deal-expiration",
    "accepted-deal-rejection",
    "access-control-guards",
    "activation-lifecycle-guards",
    "actor-token-guards",
    "basic-activation",
    "curio-restart-replay",
  "deal-termination",
    "direct-onboarding-notification",
    "direct-onboarding-notification-failure",
    "evidence-authority-guards",
    "evidence-no-claim-activation-guard",
    "full-available",
    "multi-claim-evidence-batches",
    "negative-activation",
    "prepare-devnet",
    "proposal-smoke",
    "sector-status-active",
    "sector-status-negative",
    "settlement-guards",
    "shared-client-multi-rail-settlement",
    "termination-settlement",
    "upgrade-continuity",
    "validator-rail-smoke"
  ]);
});

test("scenario registry rejects unknown names instead of silently aliasing them", () => {
  assert.throws(() => resolveScenario("activation-only"), /unknown scenario: activation-only/);
});

test("every scenario has small valid static metadata", () => {
  for (const [name, definition] of Object.entries(scenarioDefinitions)) {
    assert.ok(definition.tags.length > 0, `${name} needs at least one tag`);
    assert.ok(definition.timeoutMs > 0, `${name} needs a positive timeout`);
    assert.equal(
      new Set(definition.requiredContracts).size,
      definition.requiredContracts.length,
      `${name} has duplicate required contracts`,
    );
  }
});

test("named suites resolve to registered scenarios", () => {
  assert.deepEqual(resolveSuite("curio"), [
    "activation-lifecycle-guards",
    "basic-activation",
    "curio-restart-replay",
  "deal-termination",
    "direct-onboarding-notification",
    "direct-onboarding-notification-failure",
    "evidence-authority-guards",
    "full-available",
    "multi-claim-evidence-batches",
    "prepare-devnet",
    "sector-status-active",
    "sector-status-negative",
    "settlement-guards",
    "shared-client-multi-rail-settlement",
    "termination-settlement",
  ]);
  assert.deepEqual(resolveSuite("contract"), [
    "accepted-deal-expiration",
    "accepted-deal-rejection",
    "access-control-guards",
    "actor-token-guards",
    "evidence-no-claim-activation-guard",
    "negative-activation",
    "proposal-smoke",
    "validator-rail-smoke",
  ]);
  assert.ok(resolveSuite("security").includes("access-control-guards"));
  const qualificationScenarios = new Set([
    ...resolveSuite("contract"),
    ...resolveSuite("curio"),
  ]);
  assert.ok(
    resolveSuite("security").every((name) => qualificationScenarios.has(name)),
  );
  assert.deepEqual(
    resolveSuite("full"),
    scenarioNames.filter((name) => name !== "upgrade-continuity"),
  );
  assert.throws(() => resolveSuite("nightly"), /unknown suite: nightly/);
});
