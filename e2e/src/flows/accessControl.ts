import { assertEqual } from "../assertions.js";
import { readFileSync } from "node:fs";
import type { ScenarioContext } from "../runtime.js";
import { Evm, lower } from "../contracts/evm.js";
import { artifactAbis } from "../contracts/abi.js";
import { expectCustomError } from "../contracts/reverts.js";
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

  const error = await expectCustomError(
    () => evm.simulateWithPrivateKey(context.config.privateKeySp, context.config.addresses.poRepMarket, "setMinEpochsBetweenSettlements(uint256,uint256)", [
      accepted.dealId,
      before.minSettlementEpochs + 1n
    ]),
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

  const error = await expectCustomError(
    () => evm.simulateWithPrivateKey(context.config.privateKeySp, context.config.addresses.sliOracle, "setSLI(uint256,(uint16,uint64,uint16,uint8))", [
      accepted.dealId,
      "(10000,1048576,100,100)"
    ]),
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
  const error = await expectCustomError(
    () => evm.simulateWithPrivateKey(
      context.config.privateKeySp,
      context.config.addresses.poRepMarket,
      "upgradeToAndCall(address,bytes)",
      [implementation, "0x"],
    ),
    artifactAbis(context).poRepMarket,
    "AccessControlUnauthorizedAccount",
  );
  assertEqual(lower(error.args[0]), lower(caller), "unauthorized upgrade caller");
  const after = evm.storage(context.config.addresses.poRepMarket, implementationSlot);
  assertEqual(after, before, "implementation pointer after unauthorized upgrade");
  console.log(`  Unauthorized upgrade failed with ${error.name}`);
}

export async function expectUnauthorizedEvidenceRefreshToFail(
  context: ScenarioContext,
  accepted: AcceptedDeal
): Promise<void> {
  requireDevnet(context);
  const evm = new Evm(context);
  const view = contracts(context);
  const caller = evm.addressForPrivateKey(context.config.privateKeySp);
  await evm.ensureEvmActor(context.config.privateKeySp);
  const before = await view.evidenceStatus(accepted.dealId);
  const evidenceData = evm.abiEncode("f(uint256)", 1n);

  console.log("=== Expect unauthorized market evidence refresh to fail ===");
  console.log(`  Deal: ${accepted.dealId}`);
  console.log(`  Caller: ${caller}`);
  console.log(`  Evidence before: result=${before.result}, checked=${before.checkedClaims}/${before.totalClaims}, bytes=${before.activeCoveredBytes}`);

  const error = await expectCustomError(
    () => evm.simulateWithPrivateKey(context.config.privateKeySp, context.config.addresses.poRepMarket, "refreshEvidenceStatus(uint256,bytes)", [
      accepted.dealId,
      evidenceData
    ]),
    artifactAbis(context).poRepMarket,
    "AccessControlUnauthorizedAccount"
  );
  assertEqual(lower(error.args[0]), lower(caller), "unauthorized evidence refresh caller");
  console.log(`  Unauthorized market refresh failed with ${error.name}`);

  const after = await view.evidenceStatus(accepted.dealId);
  assertEqual(after.activeCoveredBytes, before.activeCoveredBytes, "activeCoveredBytes after unauthorized market refresh");
  assertEqual(after.lastEvidenceRefreshEpoch, before.lastEvidenceRefreshEpoch, "lastEvidenceRefreshEpoch after unauthorized market refresh");
  assertEqual(after.reasonCode, before.reasonCode, "reasonCode after unauthorized market refresh");
  assertEqual(after.result, before.result, "result after unauthorized market refresh");
  assertEqual(after.checkedClaims, before.checkedClaims, "checkedClaims after unauthorized market refresh");
  assertEqual(after.totalClaims, before.totalClaims, "totalClaims after unauthorized market refresh");
  console.log("Expected failure observed for: unauthorized market evidence refresh");
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

  const error = await expectCustomError(
    () => evm.simulate(
      context.config.addresses.dataCapEvidenceAdapter,
      "refreshEvidenceStatus((uint256,uint256,address,uint64,uint16,uint64),bytes)",
      [activationContext, evidenceData]
    ),
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
