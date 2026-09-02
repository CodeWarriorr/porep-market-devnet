import { assertEqual } from "../assertions.js";
import { readFileSync } from "node:fs";
import { id as keccakText } from "ethers";
import type { ScenarioContext } from "../runtime.js";
import { Evm, lower } from "../contracts/evm.js";
import { artifactAbis } from "../contracts/abi.js";
import { expectRevertOnSend } from "../contracts/reverts.js";
import { contracts } from "../contracts/views.js";
import { requireDevnet } from "../devnet/docker.js";
import type { AcceptedDeal } from "./deal.js";

const implementationSlot =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

export async function expectUnauthorizedSettlementCadenceUpdateToFail(
  context: ScenarioContext,
  accepted: AcceptedDeal
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const caller = evm.addressForPrivateKey(context.config.privateKeySp);
  await evm.ensureEvmActor(context.config.privateKeySp);
  const before = await view.dealService(accepted.dealId);

  console.log("=== Expect unauthorized settlement cadence update to fail ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Caller: ${caller}`);
  console.log(`  Existing min epochs: ${before.minSettlementEpochs}`);

  const error = await expectRevertOnSend(
    evm,
    context.config.privateKeySp,
    context.config.addresses.poRepMarket,
    "setMinEpochsBetweenSettlements(uint256,uint256)",
    [
      accepted.dealId,
      before.minSettlementEpochs + 1n
    ],
    artifactAbis(context).poRepMarket,
    "AccessControlUnauthorizedAccount"
  );
  assertEqual(lower(error.args[0]), lower(caller), "unauthorized cadence caller");
  console.log(`  Unauthorized cadence update failed with ${error.name}`);

  const after = await view.dealService(accepted.dealId);
  assertEqual(after.minSettlementEpochs, before.minSettlementEpochs, "min settlement epochs after unauthorized update");
  console.log("Expected failure observed for: unauthorized settlement cadence update");
}

export async function expectUnauthorizedSliUpdateToFail(
  context: ScenarioContext,
  accepted: AcceptedDeal
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const caller = evm.addressForPrivateKey(context.config.privateKeySp);
  await evm.ensureEvmActor(context.config.privateKeySp);
  const before = await view.sliAttestation(accepted.dealId);

  console.log("=== Expect unauthorized SLI update to fail ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Caller: ${caller}`);
  console.log(`  Existing SLI last update: ${before.lastUpdate}`);

  const error = await expectRevertOnSend(
    evm,
    context.config.privateKeySp,
    context.config.addresses.sliOracle,
    "setSLI(uint256,(uint16,uint64,uint16,uint8))",
    [
      accepted.dealId,
      "(10000,1048576,100,100)"
    ],
    artifactAbis(context).sliOracle,
    "AccessControlUnauthorizedAccount"
  );
  assertEqual(lower(error.args[0]), lower(caller), "unauthorized SLI caller");
  console.log(`  Unauthorized SLI update failed with ${error.name}`);

  const after = await view.sliAttestation(accepted.dealId);
  assertEqual(after.lastUpdate, before.lastUpdate, "SLI last update after unauthorized update");
  assertEqual(after.slis.retrievabilityBps, before.slis.retrievabilityBps, "SLI retrievability after unauthorized update");
  assertEqual(after.slis.bandwidthBytesPerSecond, before.slis.bandwidthBytesPerSecond, "SLI bandwidth after unauthorized update");
  assertEqual(after.slis.latencyMs, before.slis.latencyMs, "SLI latency after unauthorized update");
  assertEqual(after.slis.indexingAvailabilityPct, before.slis.indexingAvailabilityPct, "SLI indexing after unauthorized update");
  console.log("Expected failure observed for: unauthorized SLI update");
}

export async function expectUnauthorizedUpgradeToFail(
  context: ScenarioContext,
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const caller = evm.addressForPrivateKey(context.config.privateKeySp);
  await evm.ensureEvmActor(context.config.privateKeySp);
  const deployment = JSON.parse(
    readFileSync(context.config.deploymentRecordPath, "utf8"),
  ) as { contracts: { PoRepMarket: { implementation: string } } };
  const implementation = deployment.contracts.PoRepMarket.implementation;
  const before = evm.storage(context.config.addresses.poRepMarket, implementationSlot);

  console.log("=== Expect unauthorized PoRep Market upgrade to fail ===");
  console.log(`  Caller: ${caller}`);
  const error = await expectRevertOnSend(
    evm,
    context.config.privateKeySp,
    context.config.addresses.poRepMarket,
    "upgradeToAndCall(address,bytes)",
    [implementation, "0x"],
    artifactAbis(context).poRepMarket,
    "AccessControlUnauthorizedAccount",
  );
  assertEqual(lower(error.args[0]), lower(caller), "unauthorized upgrade caller");
  const after = evm.storage(context.config.addresses.poRepMarket, implementationSlot);
  assertEqual(after, before, "implementation pointer after unauthorized upgrade");
  console.log(`  Unauthorized upgrade failed with ${error.name}`);
}

export async function expectUnauthorizedProviderCapacityWritesToFail(
  context: ScenarioContext,
  accepted: AcceptedDeal,
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const caller = evm.addressForPrivateKey(context.config.privateKeySp);
  const marketRole = keccakText("MARKET_ROLE");
  const manifest = await view.dealData(accepted.dealId);
  await evm.ensureEvmActor(context.config.privateKeySp);
  const before = await view.providerCapacity(accepted.deal.provider);

  const calls = [
    {
      label: "commitCapacity",
      signature: "commitCapacity(uint64,uint256,uint256)",
      args: [accepted.deal.provider, accepted.requestedSizeBytes, accepted.requestedSizeBytes],
    },
    {
      label: "releaseCapacity",
      signature: "releaseCapacity(uint64,uint256,address,bytes32)",
      args: [accepted.deal.provider, 1n, accepted.deal.client, manifest.manifestHash],
    },
    {
      label: "releasePendingCapacity",
      signature: "releasePendingCapacity(uint64,uint256,address,bytes32)",
      args: [accepted.deal.provider, 1n, accepted.deal.client, manifest.manifestHash],
    },
  ] as const;

  for (const call of calls) {
    const error = await expectRevertOnSend(
      evm,
      context.config.privateKeySp,
      context.config.addresses.spRegistry,
      call.signature,
      [...call.args],
      artifactAbis(context).spRegistry,
      "AccessControlUnauthorizedAccount",
    );
    assertEqual(lower(error.args[0]), lower(caller), `${call.label} unauthorized caller`);
    assertEqual(lower(error.args[1]), lower(marketRole), `${call.label} required role`);
    assertProviderCapacityEqual(
      await view.providerCapacity(accepted.deal.provider),
      before,
      `provider capacity after unauthorized ${call.label}`,
    );
  }
}

export async function expectDirectDealSettlementValidationToFail(
  context: ScenarioContext,
  accepted: AcceptedDeal,
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const caller = evm.addressForPrivateKey(context.config.privateKeySp);
  await evm.ensureEvmActor(context.config.privateKeySp);
  const before = await view.dealService(accepted.dealId);

  const error = await expectRevertOnSend(
    evm,
    context.config.privateKeySp,
    context.config.addresses.poRepMarket,
    "validateDealSettlement(uint256,uint256,uint256)",
    [accepted.dealId, 0n, 1n],
    artifactAbis(context).poRepMarket,
    "CallerIsNotValidator",
  );
  assertEqual(error.args[0], accepted.dealId, "settlement validation guard deal id");
  assertEqual(lower(error.args[1]), lower(caller), "settlement validation guard caller");

  const after = await view.dealService(accepted.dealId);
  assertEqual(after.startEpoch, before.startEpoch, "service start after direct settlement validation");
  assertEqual(after.endEpoch, before.endEpoch, "service end after direct settlement validation");
  assertEqual(after.earlyTerminationEpoch, before.earlyTerminationEpoch, "early termination after direct settlement validation");
  assertEqual(after.minSettlementEpochs, before.minSettlementEpochs, "settlement cadence after direct settlement validation");
  assertEqual(after.lastSettledEpoch, before.lastSettledEpoch, "settlement cursor after direct settlement validation");
}

export async function expectDirectDataCapAdapterRefreshToFail(
  context: ScenarioContext,
  accepted: AcceptedDeal
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const caller = evm.signerAddress;
  const before = await view.evidenceStatus(accepted.dealId);
  const evidenceData = evm.abiEncode("f(uint256)", 1n);
  const activationContext =
    `(${accepted.dealId},${accepted.requestedSizeBytes},${accepted.deal.client},${accepted.durationEpochs},0,${accepted.deal.provider})`;

  console.log("=== Expect direct DataCap adapter refresh to fail ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Caller: ${caller}`);
  console.log("  Expected boundary: DataCapEvidenceAdapter only accepts refresh calls from PoRepMarket");

  const error = await expectRevertOnSend(
    evm,
    context.config.privateKeyTest,
    context.config.addresses.dataCapEvidenceAdapter,
    "refreshEvidenceStatus((uint256,uint256,address,uint64,uint16,uint64),bytes)",
    [activationContext, evidenceData],
    artifactAbis(context).dataCapEvidenceAdapter,
    "CallerIsNotPoRepMarket"
  );
  console.log(`  Direct adapter refresh failed with ${error.name}`);

  const after = await view.evidenceStatus(accepted.dealId);
  assertEqual(after.activeCoveredBytes, before.activeCoveredBytes, "activeCoveredBytes after direct adapter refresh attempt");
  assertEqual(after.lastEvidenceRefreshEpoch, before.lastEvidenceRefreshEpoch, "lastEvidenceRefreshEpoch after direct adapter refresh attempt");
  assertEqual(after.reasonCode, before.reasonCode, "reasonCode after direct adapter refresh attempt");
  assertEqual(after.result, before.result, "result after direct adapter refresh attempt");
  assertEqual(after.checkedClaims, before.checkedClaims, "checkedClaims after direct adapter refresh attempt");
  assertEqual(after.totalClaims, before.totalClaims, "totalClaims after direct adapter refresh attempt");
  console.log("Expected failure observed for: direct DataCap adapter refresh");
}

function assertProviderCapacityEqual(
  actual: { availableBytes: bigint; committedBytes: bigint; pendingBytes: bigint },
  expected: { availableBytes: bigint; committedBytes: bigint; pendingBytes: bigint },
  label: string,
): void {
  assertEqual(actual.availableBytes, expected.availableBytes, `${label} available bytes`);
  assertEqual(actual.committedBytes, expected.committedBytes, `${label} committed bytes`);
  assertEqual(actual.pendingBytes, expected.pendingBytes, `${label} pending bytes`);
}
