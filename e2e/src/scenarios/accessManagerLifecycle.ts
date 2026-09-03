import { readFileSync } from "node:fs";
import { id } from "ethers";
import { assertEqual } from "../assertions.js";
import { Evm, lower } from "../contracts/evm.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
import { contracts, type DealSlis } from "../contracts/views.js";
import type { ScenarioContext } from "../runtime.js";
import { runStep } from "../runtime.js";
import { runFullAvailableFlow } from "./fullAvailableFlow.js";

const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ACCESS_MANAGER_ABI = [
  "function accessManager() view returns (address)",
  "function defaultAdmin() view returns (address)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function upgradeBeacon(address beacon, address newImplementation)",
  "function getBeacon() view returns (address)",
  "function owner() view returns (address)",
  "function implementation() view returns (address)",
  "function getDealCount() view returns (uint256)",
  "error AccessControlUnauthorizedAccount(address account, bytes32 neededRole)",
] as const;

type ManifestContract = { address: string; implementation?: string };
type DeploymentManifest = { contracts: Record<string, ManifestContract> };

export function assertManagerPointer(actual: string, expected: string, target: string): void {
  assertEqual(lower(actual), lower(expected), `${target} access manager`);
}

export function assertRequiredManagerRole(hasRole: boolean, account: string, role: string): void {
  if (!hasRole) throw new Error(`${account} lacks ${role}`);
}

export async function runAccessManagerLifecycle(context: ScenarioContext): Promise<void> {
  const evm = new Evm(context);
  const beforeCount = await evm.contract(context.config.addresses.poRepMarket, ACCESS_MANAGER_ABI).getDealCount() as bigint;
  await runStep(context, "run full allocation claim activation and settlement flow", () => runFullAvailableFlow(context));
  const afterCount = await evm.contract(context.config.addresses.poRepMarket, ACCESS_MANAGER_ABI).getDealCount() as bigint;
  assertEqual(afterCount, beforeCount + 1n, "full flow created exactly one deal");
  const dealId = afterCount;
  const manifest = deploymentManifest(context);
  const manager = managerAddress(manifest);

  await runStep(context, "assert AccessManager topology", () =>
    assertAccessManagerTopology(context, evm, manifest, manager, dealId));
  await runStep(context, "exercise ORACLE_ROLE grant revoke and denied attestation", () =>
    exerciseOracleRoleLifecycle(context, evm, manager, dealId));
  await runStep(context, "prove direct UUPS and beacon upgrades are denied", () =>
    assertUnauthorizedUpgrades(context, evm, manifest, manager));
}

async function assertAccessManagerTopology(
  context: ScenarioContext,
  evm: Evm,
  manifest: DeploymentManifest,
  manager: string,
  dealId: bigint,
): Promise<void> {
  const targets = [
    ["PoRepMarket", context.config.addresses.poRepMarket],
    ["SPRegistry", context.config.addresses.spRegistry],
    ["SLIOracle", context.config.addresses.sliOracle],
    ["SLIScorer", contractAddress(manifest, "SLIScorer")],
    ["ValidatorFactory", context.config.addresses.validatorFactory],
    ["DataCapEvidenceAdapter", context.config.addresses.dataCapEvidenceAdapter],
  ] as const;
  for (const [name, address] of targets) {
    assertManagerPointer(
      String(await evm.contract(address, ACCESS_MANAGER_ABI).accessManager()),
      manager,
      name,
    );
  }

  const validator = await contracts(context).validatorForDeal(dealId);
  assertManagerPointer(
    String(await evm.contract(validator, ACCESS_MANAGER_ABI).accessManager()),
    manager,
    "Validator",
  );

  const beacon = String(await evm.contract(context.config.addresses.validatorFactory, ACCESS_MANAGER_ABI).getBeacon());
  assertEqual(lower(beacon), lower(contractAddress(manifest, "ValidatorBeacon")), "ValidatorFactory beacon");
  assertEqual(lower(String(await evm.contract(beacon, ACCESS_MANAGER_ABI).owner())), lower(manager), "Validator beacon owner");

  const accessManager = evm.contract(manager, ACCESS_MANAGER_ABI);
  const admin = String(await accessManager.defaultAdmin());
  const defaultAdminRole = "0x".padEnd(66, "0");
  const upgraderRole = id("UPGRADER_ROLE");
  const porepServiceRole = id("POREP_SERVICE_ROLE");
  const deploymentIdentity = context.config.identityAddresses.deployer;
  assertEqual(lower(admin), lower(deploymentIdentity), "default admin bootstrap identity");
  assertRequiredManagerRole(await accessManager.hasRole(defaultAdminRole, deploymentIdentity), deploymentIdentity, "DEFAULT_ADMIN_ROLE");
  assertRequiredManagerRole(await accessManager.hasRole(upgraderRole, deploymentIdentity), deploymentIdentity, "UPGRADER_ROLE");
  if (await accessManager.hasRole(porepServiceRole, admin)) {
    throw new Error(`default admin ${admin} unexpectedly has POREP_SERVICE_ROLE`);
  }
}

async function exerciseOracleRoleLifecycle(
  context: ScenarioContext,
  evm: Evm,
  manager: string,
  dealId: bigint,
): Promise<void> {
  const accessManager = evm.contract(manager, ACCESS_MANAGER_ABI);
  const oracleRole = id("ORACLE_ROLE");
  const testKey = context.config.privateKeySp;
  const testAccount = evm.addressForPrivateKey(testKey);
  const initiallyAuthorized = Boolean(await accessManager.hasRole(oracleRole, testAccount));
  if (initiallyAuthorized) {
    throw new Error(`test account ${testAccount} unexpectedly has ORACLE_ROLE before the grant`);
  }
  let granted = false;
  try {
    await evm.sendWithPrivateKey(context.config.identityKeys.deployer, manager, "grantRole(bytes32,address)", [oracleRole, testAccount]);
    granted = true;
    assertRequiredManagerRole(await accessManager.hasRole(oracleRole, testAccount), testAccount, "ORACLE_ROLE after grant");

    const view = contracts(context);
    const beforeGrantUpdate = await view.sliAttestation(dealId);
    const grantedSlis = differentRetrievability(beforeGrantUpdate.slis);
    await evm.sendWithPrivateKey(testKey, context.config.addresses.sliOracle, "setSLI(uint256,(uint16,uint64,uint16,uint8))", [dealId, sliTuple(grantedSlis)]);
    const afterGrantUpdate = await view.sliAttestation(dealId);
    if (afterGrantUpdate.lastUpdate <= beforeGrantUpdate.lastUpdate) {
      throw new Error(`authorized SLI last update did not advance: before ${beforeGrantUpdate.lastUpdate}, after ${afterGrantUpdate.lastUpdate}`);
    }
    assertSlisEqual(afterGrantUpdate.slis, grantedSlis, "authorized SLI update");

    if (granted) {
      await evm.sendWithPrivateKey(context.config.identityKeys.deployer, manager, "revokeRole(bytes32,address)", [oracleRole, testAccount]);
      granted = false;
    }
    const beforeDeniedUpdate = await view.sliAttestation(dealId);
    const error = await expectRevertOnSend(
      evm,
      testKey,
      context.config.addresses.sliOracle,
      "setSLI(uint256,(uint16,uint64,uint16,uint8))",
      [dealId, sliTuple(beforeDeniedUpdate.slis)],
      ACCESS_MANAGER_ABI,
      "AccessControlUnauthorizedAccount",
    );
    assertEqual(lower(String(error.args[0])), lower(testAccount), "denied SLI account");
    assertEqual(lower(String(error.args[1])), lower(oracleRole), "denied SLI role");
    assertAttestationEqual(await view.sliAttestation(dealId), beforeDeniedUpdate, "SLI attestation after denied update");
  } finally {
    if (granted) {
      await evm.sendWithPrivateKey(context.config.identityKeys.deployer, manager, "revokeRole(bytes32,address)", [oracleRole, testAccount]);
    }
  }
}

async function assertUnauthorizedUpgrades(
  context: ScenarioContext,
  evm: Evm,
  manifest: DeploymentManifest,
  manager: string,
): Promise<void> {
  const callerKey = context.config.privateKeySp;
  const caller = evm.addressForPrivateKey(callerKey);
  const upgraderRole = id("UPGRADER_ROLE");
  const targetNames = ["PoRepMarket", "SPRegistry", "SLIOracle", "SLIScorer", "ValidatorFactory", "DataCapEvidenceAdapter"] as const;
  for (const name of targetNames) {
    const target = contractAddress(manifest, name);
    const implementation = implementationAddress(manifest, name);
    const before = evm.storage(target, IMPLEMENTATION_SLOT);
    const error = await expectRevertOnSend(
      evm, callerKey, target, "upgradeToAndCall(address,bytes)", [implementation, "0x"], ACCESS_MANAGER_ABI, "AccessControlUnauthorizedAccount",
    );
    assertEqual(lower(String(error.args[0])), lower(caller), `${name} denied upgrade account`);
    assertEqual(lower(String(error.args[1])), lower(upgraderRole), `${name} denied upgrade role`);
    assertEqual(evm.storage(target, IMPLEMENTATION_SLOT), before, `${name} implementation after denied upgrade`);
  }

  const beacon = contractAddress(manifest, "ValidatorBeacon");
  const implementation = validatorImplementationAddress(manifest);
  const beforeOwner = String(await evm.contract(beacon, ACCESS_MANAGER_ABI).owner());
  const beforeImplementation = String(await evm.contract(beacon, ACCESS_MANAGER_ABI).implementation());
  const error = await expectRevertOnSend(
    evm, callerKey, manager, "upgradeBeacon(address,address)", [beacon, implementation], ACCESS_MANAGER_ABI, "AccessControlUnauthorizedAccount",
  );
  assertEqual(lower(String(error.args[0])), lower(caller), "denied beacon upgrade account");
  assertEqual(lower(String(error.args[1])), lower(upgraderRole), "denied beacon upgrade role");
  assertEqual(String(await evm.contract(beacon, ACCESS_MANAGER_ABI).owner()), beforeOwner, "beacon owner after denied upgrade");
  assertEqual(String(await evm.contract(beacon, ACCESS_MANAGER_ABI).implementation()), beforeImplementation, "beacon implementation after denied upgrade");
}

function deploymentManifest(context: ScenarioContext): DeploymentManifest {
  return JSON.parse(readFileSync(context.config.deploymentRecordPath, "utf8")) as DeploymentManifest;
}

function managerAddress(manifest: DeploymentManifest): string {
  return contractAddress(manifest, "AccessManager");
}

function contractAddress(manifest: DeploymentManifest, name: string): string {
  const address = manifest.contracts[name]?.address;
  if (address === undefined) throw new Error(`deployment manifest is missing ${name}.address`);
  return address;
}

function implementationAddress(manifest: DeploymentManifest, name: string): string {
  const implementation = manifest.contracts[name]?.implementation;
  if (implementation === undefined) throw new Error(`deployment manifest is missing ${name}.implementation`);
  return implementation;
}

function validatorImplementationAddress(manifest: DeploymentManifest): string {
  return manifest.contracts.ValidatorBeacon?.implementation
    ?? contractAddress(manifest, "ValidatorImplementation");
}

function sliTuple(slis: DealSlis): string {
  return `(${slis.retrievabilityBps},${slis.bandwidthBytesPerSecond},${slis.latencyMs},${slis.indexingAvailabilityPct})`;
}

function differentRetrievability(slis: DealSlis): DealSlis {
  return {
    ...slis,
    retrievabilityBps: slis.retrievabilityBps === 10_000n
      ? 9_999n
      : slis.retrievabilityBps + 1n,
  };
}

function assertAttestationEqual(
  actual: { lastUpdate: bigint; slis: DealSlis },
  expected: { lastUpdate: bigint; slis: DealSlis },
  label: string,
): void {
  assertEqual(actual.lastUpdate, expected.lastUpdate, `${label} last update`);
  assertSlisEqual(actual.slis, expected.slis, label);
}

function assertSlisEqual(actual: DealSlis, expected: DealSlis, label: string): void {
  assertEqual(actual.retrievabilityBps, expected.retrievabilityBps, `${label} retrievability`);
  assertEqual(actual.bandwidthBytesPerSecond, expected.bandwidthBytesPerSecond, `${label} bandwidth`);
  assertEqual(actual.latencyMs, expected.latencyMs, `${label} latency`);
  assertEqual(actual.indexingAvailabilityPct, expected.indexingAvailabilityPct, `${label} indexing availability`);
}
