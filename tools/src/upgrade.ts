import { isAbsolute } from "node:path";
import type {
  DeploymentRevision,
  RevisionContract,
} from "./deployment.js";

export type UpgradeStep = {
  contract: string;
  kind: "uups" | "validator-beacon";
  calldata: string;
};

export type UpgradePlan = {
  deploymentId: string;
  fromRevision: number;
  targetSnapshotPath: string;
  steps: UpgradeStep[];
};

export function createUpgradePlan(input: {
  revision: DeploymentRevision;
  targetSnapshotPath: string;
  contracts: string[];
  calldata?: Record<string, string>;
}): UpgradePlan {
  if (!isAbsolute(input.targetSnapshotPath)) {
    throw new Error("upgrade targetSnapshotPath must be absolute");
  }
  if (input.contracts.length === 0) {
    throw new Error("upgrade plan needs at least one contract");
  }
  if (new Set(input.contracts).size !== input.contracts.length) {
    throw new Error("duplicate upgrade contract");
  }

  return {
    deploymentId: input.revision.deploymentId,
    fromRevision: input.revision.revision,
    targetSnapshotPath: input.targetSnapshotPath,
    steps: input.contracts.map((name) => {
      const contract = input.revision.contracts[name];
      if (!contract) throw new Error(`unknown contract: ${name}`);
      return {
        contract: name,
        kind: upgradeKind(name, contract),
        calldata: input.calldata?.[name] ?? "0x",
      };
    }),
  };
}

export function validateUpgradePreflight(input: {
  plan: UpgradePlan;
  revision: DeploymentRevision;
  liveImplementations: Record<string, string>;
  authorizedContracts: Set<string>;
}): void {
  if (input.plan.deploymentId !== input.revision.deploymentId) {
    throw new Error("upgrade deploymentId mismatch");
  }
  if (input.plan.fromRevision !== input.revision.revision) {
    throw new Error("stale fromRevision");
  }
  for (const step of input.plan.steps) {
    const contract = input.revision.contracts[step.contract];
    if (!contract?.implementation) {
      throw new Error(`upgrade contract is missing implementation: ${step.contract}`);
    }
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(step.calldata)) {
      throw new Error(`upgrade calldata must be explicit hex: ${step.contract}`);
    }
    const live = input.liveImplementations[step.contract];
    if (!live || live.toLowerCase() !== contract.implementation.toLowerCase()) {
      throw new Error(`live implementation mismatch: ${step.contract}`);
    }
    if (!input.authorizedContracts.has(step.contract)) {
      throw new Error(`missing upgrade authority: ${step.contract}`);
    }
  }
}

function upgradeKind(
  name: string,
  contract: RevisionContract,
): UpgradeStep["kind"] {
  if (contract.kind === "uups") return "uups";
  if (contract.kind === "beacon" && name === "ValidatorBeacon") {
    return "validator-beacon";
  }
  throw new Error(`cannot upgrade direct contract: ${name}`);
}
