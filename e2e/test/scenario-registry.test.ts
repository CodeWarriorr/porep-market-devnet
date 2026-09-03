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
    "activation-padding-bounds",
    "actor-token-guards",
    "adapter-disable",
    "basic-activation",
    "capacity-exhaustion",
    "client-funds-exhaustion",
    "curio-restart-replay",
    "datacap-malformed-input",
    "deal-termination",
    "direct-onboarding-notification",
    "direct-onboarding-notification-failure",
    "duplicate-manifest-lifecycle",
    "evidence-authority-guards",
    "evidence-no-claim-activation-guard",
    "full-available",
    "multi-claim-evidence-batches",
    "negative-activation",
    "post-datacap-evidence-correlation",
    "prepare-devnet",
    "proposal-smoke",
    "sector-evidence-batched-commit",
    "sector-evidence-large-refresh",
    "sector-evidence-multi-piece-activation",
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

test("registers Wave 3 scenarios while keeping the irreversible adapter disable direct-only", () => {
  for (const name of [
    "client-funds-exhaustion",
    "capacity-exhaustion",
    "datacap-malformed-input",
    "adapter-disable",
  ]) {
    assert.ok(scenarioNames.includes(name), `${name} is registered`);
    assert.equal(resolveScenario(name), scenarioDefinitions[name]);
  }

  assert.equal(scenarioDefinitions["adapter-disable"]?.destructive, true);
  assert.equal(
    scenarioDefinitions["adapter-disable"]?.timeoutMs,
    2 * 60 * 60_000,
    "adapter-disable retains enough time for a real provider claim",
  );
  for (const suite of ["full", "contract", "curio", "security"] as const) {
    assert.ok(!resolveSuite(suite).includes("adapter-disable"), `${suite} excludes adapter-disable`);
  }
});

test("registers the large sector refresh as direct-only", () => {
  const definition = scenarioDefinitions["sector-evidence-large-refresh"];
  assert.ok(definition);
  assert.equal(definition.directOnly, true);
  assert.equal(definition.timeoutMs, 12 * 60 * 60_000);
  for (const suite of ["full", "contract", "curio", "security"] as const) {
    assert.ok(
      !resolveSuite(suite).includes("sector-evidence-large-refresh"),
      `${suite} excludes sector-evidence-large-refresh`,
    );
  }
});

test("registers the batched Curio commit as direct-only", () => {
  const definition = scenarioDefinitions["sector-evidence-batched-commit"];
  assert.ok(definition);
  assert.equal(definition.directOnly, true);
  assert.equal(definition.timeoutMs, 12 * 60 * 60_000);
  for (const suite of ["full", "contract", "curio", "security"] as const) {
    assert.ok(
      !resolveSuite(suite).includes("sector-evidence-batched-commit"),
      `${suite} excludes sector-evidence-batched-commit`,
    );
  }
});

test("registers T3 contract security scenarios", () => {
  for (const name of [
    "activation-padding-bounds",
    "duplicate-manifest-lifecycle",
  ]) {
    assert.ok(scenarioNames.includes(name), `${name} is registered`);
    assert.equal(resolveScenario(name), scenarioDefinitions[name]);
    assert.deepEqual(scenarioDefinitions[name]?.tags, ["contract", "security"]);
  }
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
    "client-funds-exhaustion",
    "curio-restart-replay",
    "deal-termination",
    "direct-onboarding-notification",
    "direct-onboarding-notification-failure",
    "evidence-authority-guards",
    "full-available",
    "multi-claim-evidence-batches",
    "post-datacap-evidence-correlation",
    "prepare-devnet",
    "sector-evidence-multi-piece-activation",
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
    "activation-padding-bounds",
    "actor-token-guards",
    "capacity-exhaustion",
    "datacap-malformed-input",
    "duplicate-manifest-lifecycle",
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
    scenarioNames.filter((name) =>
      name !== "adapter-disable"
      && name !== "sector-evidence-batched-commit"
      && name !== "sector-evidence-large-refresh"
      && name !== "upgrade-continuity"
    ),
  );
  assert.throws(() => resolveSuite("nightly"), /unknown suite: nightly/);
});
