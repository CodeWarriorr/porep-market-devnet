import assert from "node:assert/strict";
import test from "node:test";
import { assertPreflightFacts, buildPreflightSummary, type PreflightFacts } from "../src/preflight.js";

function ready(): PreflightFacts {
  return {
    generation: "generation-a",
    provider: "t01004",
    chainId: 31415926,
    expectedChainId: 31415926,
    deploymentPorepCommit: "a".repeat(40),
    expectedPorepCommit: "a".repeat(40),
    deploymentTargetMode: "locked",
    deploymentTargetDirty: false,
    contractCount: 22,
    abiCount: 9,
    fundedIdentityCount: 8,
    requiredIdentityCount: 8,
    clientUsdc: 1_000_000n,
    providerRegistered: true,
    offerCount: 1,
    wiringReady: true,
    rolesReady: true,
    dataCapAuthority: 999n,
  };
}

test("assertPreflightFacts accepts the complete current harness state", () => {
  assert.doesNotThrow(() => assertPreflightFacts(ready()));
  assert.match(buildPreflightSummary(ready()), /ready provider=t01004/);
});

test("assertPreflightFacts reports concrete missing prerequisites", () => {
  assert.throws(
    () => assertPreflightFacts({
      ...ready(),
      fundedIdentityCount: 7,
      offerCount: 0,
      rolesReady: false,
    }),
    /all 8 test identities funded.*active provider offer.*required contract roles/s,
  );
});

test("preflight accepts additional or removed non-required contracts and ABI sets", () => {
  assert.doesNotThrow(() => assertPreflightFacts({
    ...ready(),
    contractCount: 27,
    abiCount: 11,
  }));
});

test("preflight rejects a locked deployment target commit different from versions.lock", () => {
  assert.throws(
    () => assertPreflightFacts({
      ...ready(),
      deploymentPorepCommit: "b".repeat(40),
    }),
    new RegExp(`deployment target commit mismatch: expected ${"a".repeat(40)}, got ${"b".repeat(40)}`),
  );
});

test("preflight rejects a dirty locked deployment target", () => {
  assert.throws(
    () => assertPreflightFacts({
      ...ready(),
      deploymentTargetDirty: true,
    }),
    /locked deployment target is dirty/,
  );
});

test("preflight accepts a dirty local target with explicit local evidence", () => {
  const facts: PreflightFacts = {
    ...ready(),
    deploymentPorepCommit: "b".repeat(40),
    deploymentTargetMode: "local",
    deploymentTargetDirty: true,
  };
  assert.doesNotThrow(() => assertPreflightFacts(facts));
  assert.match(
    buildPreflightSummary(facts),
    new RegExp(`target=local dirty=true commit=${"b".repeat(40)}`),
  );
});
