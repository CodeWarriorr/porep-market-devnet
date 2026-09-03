import assert from "node:assert/strict";
import test from "node:test";
import { assertPreflightFacts, buildPreflightSummary, readAccessControlFacts, type PreflightFacts } from "../src/preflight.js";

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

function aclFixture(manager = true) {
  const names = ["PoRepMarket", "DataCapEvidenceAdapter", "SPRegistry", "ValidatorFactory", "SLIOracle", "SLIScorer", "ValidatorBeacon", "TerminationOracle"];
  if (manager) names.push("AccessManager");
  return {
    contracts: Object.fromEntries(names.map((name, index) => [name, {
      address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
    }])),
    identities: { porepService: "service", operator: "operator", oracle: "oracle" },
  };
}

test("manager preflight checks six pointers, beacon ownership and five global roles", () => {
  const manifest = aclFixture();
  const manager = manifest.contracts.AccessManager!.address;
  const pointers: string[] = [];
  const members: string[][] = [];
  const facts = readAccessControlFacts(manifest, (target, signature, args = []) => {
    if (signature === "accessManager()(address)" || signature === "owner()(address)") {
      pointers.push(target);
      return manager.toUpperCase();
    }
    assert.equal(target, manager, "role calls must never use a target-local ACL");
    if (signature === "hasRole(bytes32,address)(bool)") {
      members.push(args);
      return "true";
    }
    return signature;
  });
  assert.deepEqual(facts, { wiringReady: true, rolesReady: true });
  assert.equal(new Set(pointers).size, 7);
  assert.equal(members.length, 5);
  assert.ok(members.some(([role, member]) => role === "MARKET_ROLE()(bytes32)" && member === manifest.contracts.PoRepMarket!.address));
});

test("manager preflight rejects a wrong pointer or missing global market role", () => {
  const manifest = aclFixture();
  for (const failure of ["pointer", "role"]) {
    const facts = readAccessControlFacts(manifest, (_target, signature, args = []) => {
      if (signature === "accessManager()(address)" || signature === "owner()(address)") {
        return failure === "pointer" ? "0xwrong" : manifest.contracts.AccessManager!.address;
      }
      if (signature === "hasRole(bytes32,address)(bool)") {
        return failure === "role" && args[0] === "MARKET_ROLE()(bytes32)" ? "false" : "true";
      }
      return signature;
    });
    assert.equal(failure === "pointer" ? facts.wiringReady : facts.rolesReady, false);
  }
});

test("historical preflight still reads the four target-local roles", () => {
  const manifest = aclFixture(false);
  const targets = new Set<string>();
  assert.deepEqual(readAccessControlFacts(manifest, (target, signature) => {
    assert.notEqual(signature, "accessManager()(address)");
    assert.notEqual(signature, "owner()(address)");
    targets.add(target);
    return signature === "hasRole(bytes32,address)(bool)" ? "true" : signature;
  }), { wiringReady: true, rolesReady: true });
  assert.equal(targets.size, 4);
});
