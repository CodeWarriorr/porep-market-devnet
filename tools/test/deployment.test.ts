import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertDeploymentRevisionMatchesRuntime,
  assertDeploymentMatchesRuntime,
  formatDeploymentAddresses,
  formatDeploymentRevisionAddresses,
  parseActiveDeployment,
  parseDeploymentManifest,
  parseDeploymentRevision,
  requireDeploymentContracts,
} from "../src/deployment.js";
import type { VersionLock } from "../src/lock.js";
import { loadVersionLock } from "../src/lock.js";

const toolsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(toolsRoot, "..");

const address = "0x1111111111111111111111111111111111111111";
const hash = `0x${"ab".repeat(32)}`;
const commit = "a".repeat(40);
const contractNames = [
  "MockUSDC",
  "FilecoinPay",
  "MetaAllocator",
  "AllocatorFactory",
  "PoRepMarket",
  "PoRepMarketImplementation",
  "DataCapEvidenceAdapter",
  "DataCapEvidenceAdapterImplementation",
  "ValidatorFactory",
  "ValidatorFactoryImplementation",
  "ValidatorBeacon",
  "ValidatorImplementation",
  "SPRegistry",
  "SPRegistryImplementation",
  "SLIOracle",
  "SLIOracleImplementation",
  "SLIScorer",
  "SLIScorerImplementation",
  "TerminationOracle",
  "NotificationReceiver",
  "FailingNotificationReceiver",
  "SectorStatusInspector",
] as const;

const sourceNames = [
  "blst",
  "curio",
  "lotus",
  "porep_market",
  "filecoin_pay",
  "contract_metaallocator",
  "filecoin_services",
  "multicall3",
  "fips",
] as const;

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-24T19:30:00Z",
    generation: "generation-20260724T185524Z-23892",
    genesisCid: "bafy2bzaceco3z6z6nfdpnam52jhagkckzsg5d4ds4dr46537qsfeubzngxpiw",
    chainId: 31_415_926,
    epoch: 410,
    provider: "t01004",
    sources: Object.fromEntries(sourceNames.map((name) => [name, commit])),
    identities: Object.fromEntries([
      "deployer",
      "client",
      "providerPayee",
      "porepService",
      "operator",
      "allocator",
      "oracle",
      "unauthorized",
    ].map((name) => [name, address])),
    contracts: Object.fromEntries(
      contractNames.map((name) => [name, { address, codeHash: hash }]),
    ),
  };
}

function versionLock(): VersionLock {
  return {
    schemaVersion: 1,
    sources: Object.fromEntries(sourceNames.map((name) => [
      name,
      { name, repository: `https://example.com/${name}.git`, commit, submodules: {} },
    ])),
  };
}

function validRevision(): Record<string, unknown> {
  return {
    schemaVersion: 2,
    deploymentId: "deployment-20260726T120000Z-aaaaaaaaaaaa",
    revision: 0,
    parentRevision: null,
    generatedAt: "2026-07-26T12:00:00Z",
    chain: {
      generation: "generation-20260724T185524Z-23892",
      genesisCid: "bafy2bzaceco3z6z6nfdpnam52jhagkckzsg5d4ds4dr46537qsfeubzngxpiw",
      chainId: 31_415_926,
      provider: "t01004",
      epoch: 410,
    },
    target: {
      mode: "local",
      sourcePath: "/tmp/porep",
      snapshotPath: "/tmp/runtime/porep",
      commit,
      dirty: true,
      submodules: {},
    },
    identities: { deployer: address, client: address },
    contracts: {
      PoRepMarket: {
        address,
        runtimeCodeHash: hash,
        kind: "uups",
        implementation: "0x2222222222222222222222222222222222222222",
        implementationCodeHash: hash,
      },
      ValidatorBeacon: {
        address: "0x3333333333333333333333333333333333333333",
        runtimeCodeHash: hash,
        kind: "beacon",
        implementation: "0x4444444444444444444444444444444444444444",
        implementationCodeHash: hash,
      },
      FutureAuditFixture: {
        address: "0x5555555555555555555555555555555555555555",
        runtimeCodeHash: hash,
        kind: "direct",
      },
    },
    transactions: [],
  };
}

test("deployment revision accepts extra contracts and binds only to chain identity", () => {
  const revision = parseDeploymentRevision(JSON.stringify(validRevision()));
  assert.equal(revision.contracts.FutureAuditFixture?.kind, "direct");
  assert.doesNotThrow(() => assertDeploymentRevisionMatchesRuntime(revision, {
    chainId: 31_415_926,
    generation: "generation-20260724T185524Z-23892",
    genesisCid: "bafy2bzaceco3z6z6nfdpnam52jhagkckzsg5d4ds4dr46537qsfeubzngxpiw",
    provider: "t01004",
  }));
  assert.doesNotThrow(() => requireDeploymentContracts(revision, ["PoRepMarket"]));
  assert.throws(
    () => requireDeploymentContracts(revision, ["DataCapEvidenceAdapter"]),
    /DataCapEvidenceAdapter/,
  );
});

test("deployment revision validates proxy metadata, lineage, and active selection", () => {
  for (const mutate of [
    (value: Record<string, any>) => { value.revision = 1; },
    (value: Record<string, any>) => { delete value.contracts.PoRepMarket.implementation; },
    (value: Record<string, any>) => { value.contracts.FutureAuditFixture.runtimeCodeHash = "0x"; },
    (value: Record<string, any>) => { value.target.commit = "bad"; },
  ]) {
    const value = validRevision();
    mutate(value);
    assert.throws(() => parseDeploymentRevision(JSON.stringify(value)));
  }
  assert.deepEqual(
    parseActiveDeployment('{"schemaVersion":1,"deploymentId":"deployment-a","revision":3}'),
    { schemaVersion: 1, deploymentId: "deployment-a", revision: 3 },
  );
  assert.throws(
    () => parseActiveDeployment('{"schemaVersion":1,"deploymentId":"../escape","revision":0}'),
    /deploymentId/,
  );
});

test("deployment revision address output identifies the selected revision", () => {
  const output = formatDeploymentRevisionAddresses(
    parseDeploymentRevision(JSON.stringify(validRevision())),
  );
  assert.match(output, /^deploymentId\tdeployment-20260726T120000Z-aaaaaaaaaaaa$/m);
  assert.match(output, /^revision\t0$/m);
  assert.match(output, new RegExp(`^PoRepMarket\\t${address}$`, "m"));
  assert.doesNotMatch(output, /implementation|codeHash|sourcePath/i);
});

test("deployment revision CLI inspects chain identity and prints addresses", () => {
  const input = JSON.stringify(validRevision());
  const inspect = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    "deployment",
    "revision",
    "inspect",
    "generation-20260724T185524Z-23892",
    "bafy2bzaceco3z6z6nfdpnam52jhagkckzsg5d4ds4dr46537qsfeubzngxpiw",
    "31415926",
    "t01004",
  ], { cwd: toolsRoot, encoding: "utf8", input });
  assert.equal(inspect.status, 0, inspect.stderr);
  const addresses = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    "deployment",
    "revision",
    "addresses",
  ], { cwd: toolsRoot, encoding: "utf8", input });
  assert.equal(addresses.status, 0, addresses.stderr);
  assert.match(addresses.stdout, /^deploymentId\tdeployment-20260726T120000Z-aaaaaaaaaaaa$/m);
});

test("deployment manifest accepts the complete current public deployment record", () => {
  const manifest = parseDeploymentManifest(JSON.stringify(validManifest()));
  assert.equal(manifest.contracts.PoRepMarket.address, address);
  assert.doesNotThrow(() => assertDeploymentMatchesRuntime(
    manifest,
    {
      chainId: 31_415_926,
      generation: "generation-20260724T185524Z-23892",
      genesisCid: "bafy2bzaceco3z6z6nfdpnam52jhagkckzsg5d4ds4dr46537qsfeubzngxpiw",
      provider: "t01004",
    },
    versionLock(),
  ));
});

test("deployment manifest rejects malformed or stale deployment evidence", () => {
  for (const mutate of [
    (value: Record<string, any>) => { value.chainId = 1; },
    (value: Record<string, any>) => { value.generation = "old"; },
    (value: Record<string, any>) => { value.sources.curio = "b".repeat(40); },
    (value: Record<string, any>) => { delete value.contracts.FilecoinPay; },
    (value: Record<string, any>) => { value.contracts.PoRepMarket.codeHash = "0x"; },
  ]) {
    const value = validManifest();
    mutate(value);
    assert.throws(() => {
      const manifest = parseDeploymentManifest(JSON.stringify(value));
      assertDeploymentMatchesRuntime(
        manifest,
        {
          chainId: 31_415_926,
          generation: "generation-20260724T185524Z-23892",
          genesisCid: "bafy2bzaceco3z6z6nfdpnam52jhagkckzsg5d4ds4dr46537qsfeubzngxpiw",
          provider: "t01004",
        },
        versionLock(),
      );
    });
  }
});

test("deployment addresses output contains only public identity and contract data", () => {
  const output = formatDeploymentAddresses(
    parseDeploymentManifest(JSON.stringify(validManifest())),
  );
  assert.match(output, /^chainId\t31415926$/m);
  assert.match(output, /^generation\tgeneration-20260724T185524Z-23892$/m);
  assert.match(output, /^provider\tt01004$/m);
  assert.match(output, new RegExp(`^PoRepMarket\\t${address}$`, "m"));
  assert.doesNotMatch(output, /private|secret|codeHash/i);
});

test("deployment CLI validates current identity and prints public addresses", async () => {
  const value = validManifest();
  const lock = await loadVersionLock(join(repositoryRoot, "versions.lock.yaml"));
  value.sources = Object.fromEntries(
    Object.entries(lock.sources).map(([name, source]) => [name, source.commit]),
  );
  const input = JSON.stringify(value);
  const inspect = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    "deployment",
    "inspect",
    "generation-20260724T185524Z-23892",
    "bafy2bzaceco3z6z6nfdpnam52jhagkckzsg5d4ds4dr46537qsfeubzngxpiw",
    "31415926",
    "t01004",
  ], { cwd: toolsRoot, encoding: "utf8", input });
  assert.equal(inspect.status, 0, inspect.stderr);
  assert.equal(inspect.stdout, "deployment manifest is current\n");

  const addresses = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "src/cli.ts",
    "deployment",
    "addresses",
  ], { cwd: toolsRoot, encoding: "utf8", input });
  assert.equal(addresses.status, 0, addresses.stderr);
  assert.match(addresses.stdout, new RegExp(`^PoRepMarket\\t${address}$`, "m"));
});

test("harness contracts use the pinned compiler and bounded runtime-only build", async () => {
  const [foundry, remappings, mockUsdc, receiver, failingReceiver, terminationOracle, buildScript] = await Promise.all([
    readFile(join(repositoryRoot, "contracts/foundry.toml"), "utf8"),
    readFile(join(repositoryRoot, "contracts/remappings.txt"), "utf8"),
    readFile(join(repositoryRoot, "contracts/src/MockUSDC.sol"), "utf8"),
    readFile(join(repositoryRoot, "contracts/src/NotificationReceiver.sol"), "utf8"),
    readFile(join(repositoryRoot, "contracts/src/FailingNotificationReceiver.sol"), "utf8"),
    readFile(join(repositoryRoot, "contracts/src/TerminationOracle.sol"), "utf8"),
    readFile(join(repositoryRoot, "scripts/contracts-build.sh"), "utf8"),
  ]);
  assert.match(foundry, /solc_version = "0\.8\.30"/);
  assert.match(foundry, /via_ir = true/);
  assert.match(foundry, /out = "\.\.\/\.runtime\/contracts\/out"/);
  assert.match(remappings, /^@openzeppelin\/=.*746bd19d89f3d55eb0f253e2f3fd92657e29984a/m);
  assert.match(remappings, /^filecoin-pay\/=.*755ca20054dae88e9e28dc569e696e822c59907f/m);
  assert.match(remappings, /^forge-std\/=.*746bd19d89f3d55eb0f253e2f3fd92657e29984a/m);
  assert.match(mockUsdc, /function decimals\(\).*returns \(uint8\).*6/s);
  assert.match(receiver, /handle_filecoin_method/);
  assert.match(receiver, /2034386435/);
  assert.match(receiver, /expectedMiner/);
  assert.match(receiver, /FVMSectorContentChanged\.encodeReturn/);
  assert.match(failingReceiver, /function _acceptsPiece\(\).*override.*return false/s);
  assert.match(terminationOracle, /claimsTerminatedEarly/);
  assert.match(buildScript, /run-with-timeout\.mjs.*--timeout-ms 600000/s);
  assert.match(buildScript, /curio_commit=.*\$1 == "curio"[\s\S]*image=.*curio_commit:0:12/s);
  assert.doesNotMatch(buildScript, /FOUNDRY_REMAPPINGS/);
  assert.doesNotMatch(buildScript, /forge install|foundryup|curl /);
});

test("deployment scripts create append-only revisions and an explicit active selection", async () => {
  const [justfile, deployScript, innerDeployScript, addressesScript, useScript] = await Promise.all([
    readFile(join(repositoryRoot, "justfile"), "utf8"),
    readFile(join(repositoryRoot, "scripts/devnet-deploy.sh"), "utf8"),
    readFile(join(repositoryRoot, "scripts/contracts-deploy-in-container.sh"), "utf8"),
    readFile(join(repositoryRoot, "scripts/devnet-addresses.sh"), "utf8"),
    readFile(join(repositoryRoot, "scripts/devnet-use-deployment.sh"), "utf8"),
  ]);
  assert.match(justfile, /deploy source='':\n\s+@bash scripts\/devnet-deploy\.sh/);
  assert.match(justfile, /use-deployment deployment revision='latest':/);
  assert.match(justfile, /addresses deployment='active':/);
  assert.match(deployScript, /devnet-status\.sh/);
  assert.match(deployScript, /contract-target prepare/);
  assert.match(deployScript, /\.runtime\/deployments\/.*revisions/);
  assert.match(deployScript, /active\.json/);
  assert.doesNotMatch(deployScript, /reset before redeploying/);
  assert.match(deployScript, /--timeout-ms 1800000/);
  assert.match(deployScript, /\$\{key_file\}:\/run\/secrets\/deployer-key:ro/);
  assert.match(deployScript, /\.temporary\.\$\$/);
  assert.match(deployScript, /split\("\\t"\) \| select\(length >= 3/);
  assert.match(deployScript, /lotus-shed verifreg add-verifier\s+\\?\s*t0100/);
  assert.match(deployScript, /lotus msig approve --from t0101/);
  assert.match(deployScript, /lotus filplus check-notary-datacap/);
  assert.doesNotMatch(innerDeployScript, /cast codehash/);
  assert.match(innerDeployScript, /cast code .*cast keccak/s);
  assert.match(innerDeployScript, /schemaVersion:2/);
  assert.match(innerDeployScript, /runtimeCodeHash/);
  assert.match(innerDeployScript, /implementationCodeHash/);
  for (const name of contractNames) assert.match(innerDeployScript, new RegExp(name));
  assert.match(addressesScript, /chain list --epoch 0 --count 1/);
  assert.match(addressesScript, /deployment revision inspect/);
  assert.match(addressesScript, /deployment revision addresses/);
  assert.match(useScript, /active\.json/);
  assert.match(useScript, /deployment revision inspect/);
});
