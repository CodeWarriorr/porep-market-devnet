import { readFileSync } from "node:fs";
import type { ScenarioContext } from "./runtime.js";
import { artifactAbis } from "./contracts/abi.js";
import { ensureCurioReady, filecoinAddressFromEvmStat } from "./devnet/curio.js";
import { dockerExec } from "./devnet/docker.js";
import { runRequired } from "./shell.js";

export type PreflightFacts = {
  generation: string;
  provider: string;
  chainId: number;
  expectedChainId: number;
  deploymentPorepCommit: string;
  expectedPorepCommit: string;
  deploymentTargetMode: "locked" | "local";
  deploymentTargetDirty: boolean;
  contractCount: number;
  abiCount: number;
  fundedIdentityCount: number;
  requiredIdentityCount: number;
  clientUsdc: bigint;
  providerRegistered: boolean;
  offerCount: number;
  wiringReady: boolean;
  rolesReady: boolean;
  dataCapAuthority: bigint;
};

type Manifest = {
  contracts: Record<string, { address: string }>;
  identities: Record<string, string>;
};

export function collectPreflightFacts(context: ScenarioContext): PreflightFacts {
  ensureCurioReady(context);
  runRequired("bash", ["scripts/devnet-addresses.sh"], context.projectRoot);
  const manifest = JSON.parse(
    readFileSync(context.config.deploymentRecordPath, "utf8"),
  ) as Manifest;
  const chainId = Number(cast(context, ["chain-id", "--rpc-url", context.config.rpcUrl]));
  const provider = BigInt(context.config.provider.slice(2));
  const contract = (name: string): string => manifest.contracts[name]?.address ?? "";

  const fundedIdentityCount = Object.values(manifest.identities).filter((address) =>
    firstBigInt(cast(context, ["balance", "--rpc-url", context.config.rpcUrl, address])) > 0n
  ).length;
  const clientUsdc = firstBigInt(cast(context, [
    "call", "--rpc-url", context.config.rpcUrl,
    context.config.addresses.usdcToken, "balanceOf(address)(uint256)",
    context.config.identityAddresses.client,
  ]));
  const providerRegistered = cast(context, [
    "call", "--rpc-url", context.config.rpcUrl,
    context.config.addresses.spRegistry, "isProviderRegistered(uint64)(bool)",
    provider.toString(),
  ]) === "true";
  const offerOutput = cast(context, [
    "call", "--rpc-url", context.config.rpcUrl,
    context.config.addresses.spRegistry, "getOffersByProvider(uint64)(uint256[])",
    provider.toString(),
  ]);
  const offerCount = offerOutput === "[]" ? 0 : (offerOutput.match(/\d+/g)?.length ?? 0);

  const market = context.config.addresses.poRepMarket;
  const adapter = context.config.addresses.dataCapEvidenceAdapter;
  const registry = context.config.addresses.spRegistry;
  const factory = context.config.addresses.validatorFactory;
  const sliOracle = context.config.addresses.sliOracle;
  const wiringReady = [
    [market, "getGlobalEvidenceAdapter()(address)", adapter],
    [market, "getSPRegistryContract()(address)", registry],
    [market, "getValidatorFactoryContract()(address)", factory],
    [adapter, "getPoRepMarketAddress()(address)", market],
    [factory, "getBeacon()(address)", contract("ValidatorBeacon")],
  ].every(([target, signature, expected]) =>
    equalAddress(cast(context, [
      "call", "--rpc-url", context.config.rpcUrl, target!, signature!,
    ]), expected!)
  );

  const roleChecks: Array<[string, string, string]> = [
    [market, "POREP_SERVICE_ROLE()(bytes32)", context.config.identityAddresses.porepService],
    [registry, "OPERATOR_ROLE()(bytes32)", context.config.identityAddresses.operator],
    [sliOracle, "ORACLE_ROLE()(bytes32)", context.config.identityAddresses.oracle],
    [adapter, "TERMINATION_ORACLE()(bytes32)", contract("TerminationOracle")],
  ];
  const rolesReady = roleChecks.every(([target, roleSignature, member]) => {
    const role = cast(context, [
      "call", "--rpc-url", context.config.rpcUrl, target, roleSignature,
    ]);
    return cast(context, [
      "call", "--rpc-url", context.config.rpcUrl,
      target, "hasRole(bytes32,address)(bool)", role, member,
    ]) === "true";
  });

  const metaStat = dockerExec(context, "lotus", [
    "lotus", "evm", "stat", context.config.addresses.metaAllocator,
  ]);
  const metaFilecoin = filecoinAddressFromEvmStat(metaStat);
  if (!metaFilecoin) throw new Error("could not resolve MetaAllocator Filecoin address");
  const dataCapAuthority = firstBigInt(dockerExec(context, "lotus", [
    "lotus", "filplus", "check-notary-datacap", metaFilecoin,
  ]));

  return {
    generation: context.config.generation,
    provider: context.config.provider,
    chainId,
    expectedChainId: context.config.expectedChainId,
    deploymentPorepCommit: context.config.deploymentPorepCommit,
    expectedPorepCommit: context.config.expectedPorepCommit,
    deploymentTargetMode: context.config.deploymentTargetMode,
    deploymentTargetDirty: context.config.deploymentTargetDirty,
    contractCount: Object.keys(manifest.contracts).length,
    abiCount: Object.keys(artifactAbis(context)).length,
    fundedIdentityCount,
    requiredIdentityCount: Object.keys(manifest.identities).length,
    clientUsdc,
    providerRegistered,
    offerCount,
    wiringReady,
    rolesReady,
    dataCapAuthority,
  };
}

export function assertPreflightFacts(facts: PreflightFacts): void {
  const failures: string[] = [];
  if (facts.deploymentTargetMode === "locked") {
    if (facts.deploymentTargetDirty) {
      failures.push("locked deployment target is dirty");
    }
    if (facts.deploymentPorepCommit !== facts.expectedPorepCommit) {
      failures.push(
        `deployment target commit mismatch: expected ${facts.expectedPorepCommit}, got ${facts.deploymentPorepCommit}`,
      );
    }
  }
  if (facts.chainId !== facts.expectedChainId) {
    failures.push(`chain ID ${facts.expectedChainId}`);
  }
  if (facts.fundedIdentityCount !== facts.requiredIdentityCount) {
    failures.push(`all ${facts.requiredIdentityCount} test identities funded`);
  }
  if (facts.clientUsdc <= 0n) failures.push("funded client USDC");
  if (!facts.providerRegistered) failures.push("registered provider");
  if (facts.offerCount < 1) failures.push("active provider offer");
  if (!facts.wiringReady) failures.push("required contract wiring");
  if (!facts.rolesReady) failures.push("required contract roles");
  if (facts.dataCapAuthority <= 0n) failures.push("MetaAllocator DataCap authority");
  if (failures.length > 0) throw new Error(`preflight missing: ${failures.join(", ")}`);
}

export function buildPreflightSummary(facts: PreflightFacts): string {
  return [
    `ready provider=${facts.provider} generation=${facts.generation}`,
    `chain=${facts.chainId} contracts=${facts.contractCount} abis=${facts.abiCount}`,
    `fundedIdentities=${facts.fundedIdentityCount} offers=${facts.offerCount}`,
    `target=${facts.deploymentTargetMode} dirty=${facts.deploymentTargetDirty} commit=${facts.deploymentPorepCommit}`,
    `dataCapAuthority=${facts.dataCapAuthority}`,
  ].join("\n") + "\n";
}

function cast(context: ScenarioContext, args: string[]): string {
  return runRequired("cast", args, context.projectRoot).trim();
}

function firstBigInt(value: string): bigint {
  const first = value.trim().split(/\s+/)[0];
  if (!first || !/^\d+$/.test(first)) throw new Error(`expected integer output, got: ${value}`);
  return BigInt(first);
}

function equalAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
