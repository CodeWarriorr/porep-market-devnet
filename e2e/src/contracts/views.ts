import type { Result } from "ethers";
import type { ScenarioContext } from "../runtime.js";
import { Evm, firstUint, retryTransientRead } from "./evm.js";
import { artifactAbis, type ContractAbis } from "./abi.js";

export type Deal = {
  id: bigint;
  client: string;
  provider: bigint;
  offerId: bigint;
  state: bigint;
  evidenceAdapter: string;
  dealType: bigint;
  validator: string;
  railId: bigint;
  proposedAtEpoch: bigint;
};

export type OfferPayment = {
  token: string;
  active: boolean;
  pricePer32GiBPerMonth: bigint;
};

export type DealSlis = {
  retrievabilityBps: bigint;
  bandwidthBytesPerSecond: bigint;
  latencyMs: bigint;
  indexingAvailabilityPct: bigint;
};

export type Rail = {
  token: string;
  from: string;
  to: string;
  operator: string;
  validator: string;
  paymentRate: bigint;
  settledUpTo: bigint;
  endEpoch: bigint;
  commissionRateBps: bigint;
  serviceFeeRecipient: string;
};

export type Account = {
  funds: bigint;
  lockupCurrent: bigint;
  lockupRate: bigint;
  lockupLastSettledAt: bigint;
};

export type EvidenceStatus = {
  activeCoveredBytes: bigint;
  lastEvidenceRefreshEpoch: bigint;
  reasonCode: bigint;
  result: bigint;
  checkedClaims: bigint;
  totalClaims: bigint;
};

export function contracts(context: ScenarioContext): ContractViews {
  return new ContractViews(context);
}

export class ContractViews {
  private readonly evm: Evm;
  private readonly abi: ContractAbis;

  constructor(private readonly context: ScenarioContext) {
    this.evm = new Evm(context);
    this.abi = artifactAbis(context);
  }

  async providerRegistered(provider: bigint): Promise<boolean> {
    return await retryTransientRead(
      async () => Boolean(await this.evm.contract(this.context.config.addresses.spRegistry, this.abi.spRegistry).isProviderRegistered(provider)),
      async () => await this.waitForNextBlock()
    );
  }

  async providerOfferIds(provider: bigint): Promise<bigint[]> {
    const ids = await this.evm.contract(this.context.config.addresses.spRegistry, this.abi.spRegistry).getOffersByProvider(provider) as bigint[];
    return ids;
  }

  async providerCapacity(provider: bigint): Promise<{
    availableBytes: bigint;
    committedBytes: bigint;
    pendingBytes: bigint;
  }> {
    const value = await this.evm.contract(
      this.context.config.addresses.spRegistry,
      this.abi.spRegistry,
    ).getProviderView(provider) as Result;
    return {
      availableBytes: firstUint(value[5]),
      committedBytes: firstUint(value[6]),
      pendingBytes: firstUint(value[7]),
    };
  }

  async providerPayee(provider: bigint): Promise<string> {
    const value = await this.evm.contract(
      this.context.config.addresses.spRegistry,
      this.abi.spRegistry,
    ).getProviderView(provider) as Result;
    return String(value[2]);
  }

  async offerView(offerId: bigint): Promise<Result> {
    return await this.evm.contract(this.context.config.addresses.spRegistry, this.abi.spRegistry).getOfferView(offerId) as Result;
  }

  async paymentTokenConfig(paymentToken: string): Promise<Result> {
    return await this.evm.contract(this.context.config.addresses.spRegistry, this.abi.spRegistry)
      .getPaymentTokenConfig(paymentToken) as Result;
  }

  async deal(dealId: bigint): Promise<Deal> {
    const value = await this.evm.contract(this.context.config.addresses.poRepMarket, this.abi.poRepMarket).getDeal(dealId) as Result;
    return {
      id: firstUint(value[0]),
      client: String(value[1]),
      provider: firstUint(value[2]),
      offerId: firstUint(value[3]),
      state: firstUint(value[4]),
      evidenceAdapter: String(value[5]),
      dealType: firstUint(value[6]),
      validator: String(value[7]),
      railId: firstUint(value[8]),
      proposedAtEpoch: firstUint(value[9])
    };
  }

  async dealData(dealId: bigint): Promise<{ manifestHash: string; manifestLocation: string }> {
    const value = await this.evm.contract(this.context.config.addresses.poRepMarket, this.abi.poRepMarket).getDealData(dealId) as Result;
    return { manifestHash: String(value[0]), manifestLocation: String(value[1]) };
  }

  async dealTerms(dealId: bigint): Promise<{ requestedSizeBytes: bigint; durationEpochs: bigint }> {
    const value = await this.evm.contract(this.context.config.addresses.poRepMarket, this.abi.poRepMarket).getDealTerms(dealId) as Result;
    return { requestedSizeBytes: firstUint(value[0]), durationEpochs: firstUint(value[1]) };
  }

  async dealCapacity(dealId: bigint): Promise<{ reservedBytes: bigint; committedBytes: bigint }> {
    const value = await this.evm.contract(this.context.config.addresses.poRepMarket, this.abi.poRepMarket).getDealCapacity(dealId) as Result;
    return { reservedBytes: firstUint(value[0]), committedBytes: firstUint(value[1]) };
  }

  async dealIdsByState(
    state: bigint,
    offset: bigint,
    limit: bigint,
  ): Promise<{ dealIds: bigint[]; total: bigint }> {
    const value = await this.evm.contract(
      this.context.config.addresses.poRepMarket,
      this.abi.poRepMarket,
    ).getDealIdsByState(state, offset, limit) as Result;
    return {
      dealIds: resultArrayToBigints(value[0]),
      total: firstUint(value[1]),
    };
  }

  async dealPayment(dealId: bigint): Promise<{ token: string; payee: string; pricePer32GiBPerMonth: bigint }> {
    const value = await this.evm.contract(this.context.config.addresses.poRepMarket, this.abi.poRepMarket).getDealPayment(dealId) as Result;
    return { token: String(value[0]), payee: String(value[1]), pricePer32GiBPerMonth: firstUint(value[2]) };
  }

  async dealSlis(dealId: bigint): Promise<DealSlis> {
    const value = await this.evm.contract(this.context.config.addresses.poRepMarket, this.abi.poRepMarket).getDealSLIs(dealId) as Result;
    return {
      retrievabilityBps: firstUint(value[0]),
      bandwidthBytesPerSecond: firstUint(value[1]),
      latencyMs: firstUint(value[2]),
      indexingAvailabilityPct: firstUint(value[3])
    };
  }

  async dealService(dealId: bigint): Promise<{
    startEpoch: bigint;
    endEpoch: bigint;
    earlyTerminationEpoch: bigint;
    minSettlementEpochs: bigint;
    lastSettledEpoch: bigint;
  }> {
    const value = await this.evm.contract(this.context.config.addresses.poRepMarket, this.abi.poRepMarket).getDealService(dealId) as Result;
    return {
      startEpoch: firstUint(value[0]),
      endEpoch: firstUint(value[1]),
      earlyTerminationEpoch: firstUint(value[2]),
      minSettlementEpochs: firstUint(value[3]),
      lastSettledEpoch: firstUint(value[4])
    };
  }

  async validatorForDeal(dealId: bigint): Promise<string> {
    return String(await this.evm.contract(this.context.config.addresses.validatorFactory, this.abi.validatorFactory).getInstance(dealId));
  }

  async validatorRailStatus(validator: string): Promise<bigint> {
    return firstUint(await this.evm.contract(validator, this.abi.validator).getRailStatus());
  }

  async rail(railId: bigint): Promise<Rail> {
    const value = await this.evm.contract(this.context.config.addresses.filecoinPay, this.abi.filecoinPay).getRail(railId) as Result;
    return {
      token: String(value[0]),
      from: String(value[1]),
      to: String(value[2]),
      operator: String(value[3]),
      validator: String(value[4]),
      paymentRate: firstUint(value[5]),
      settledUpTo: firstUint(value[8]),
      endEpoch: firstUint(value[9]),
      commissionRateBps: firstUint(value[10]),
      serviceFeeRecipient: String(value[11])
    };
  }

  async accountFunds(owner: string): Promise<bigint> {
    return (await this.account(owner)).funds;
  }

  async account(owner: string): Promise<Account> {
    const value = await this.evm.contract(this.context.config.addresses.filecoinPay, this.abi.filecoinPay)
      .accounts(this.context.config.addresses.usdcToken, owner) as Result;
    return {
      funds: firstUint(value[0]),
      lockupCurrent: firstUint(value[1]),
      lockupRate: firstUint(value[2]),
      lockupLastSettledAt: firstUint(value[3])
    };
  }

  async tokenBalance(owner: string): Promise<bigint> {
    return firstUint(await this.evm.contract(this.context.config.addresses.usdcToken, this.abi.erc20Permit).balanceOf(owner));
  }

  async operatorApproved(owner: string, operator: string): Promise<boolean> {
    return await retryTransientRead(
      async () => {
        const value = await this.evm.contract(this.context.config.addresses.filecoinPay, this.abi.filecoinPay)
          .operatorApprovals(this.context.config.addresses.usdcToken, owner, operator) as Result;
        return Boolean(value[0]);
      },
      async () => await this.waitForNextBlock()
    );
  }

  private async waitForNextBlock(): Promise<void> {
    await this.evm.waitForBlock(this.evm.blockNumber() + 1n);
  }

  async allocationIds(dealId: bigint): Promise<bigint[]> {
    const value = await this.evm.contract(this.context.config.addresses.dataCapEvidenceAdapter, this.abi.dataCapEvidenceAdapter)
      .getAllocationIdsPerDeal(dealId, 0n, 100n) as Result;
    return resultArrayToBigints(value[0]);
  }

  async claimIds(dealId: bigint): Promise<bigint[]> {
    const value = await this.evm.contract(this.context.config.addresses.dataCapEvidenceAdapter, this.abi.dataCapEvidenceAdapter)
      .getClaimIds(dealId, 0n, 100n) as Result;
    return resultArrayToBigints(value[0]);
  }

  async dealAllocationStatus(dealId: bigint): Promise<bigint> {
    return firstUint(await this.evm.contract(this.context.config.addresses.dataCapEvidenceAdapter, this.abi.dataCapEvidenceAdapter).getDealAllocationStatus(dealId));
  }

  async dataCapPostingFinished(dealId: bigint): Promise<boolean> {
    return Boolean(await this.evm.contract(this.context.config.addresses.dataCapEvidenceAdapter, this.abi.dataCapEvidenceAdapter).isDataCapPostingFinished(dealId));
  }

  async dataCapAllocatedBytes(dealId: bigint): Promise<bigint> {
    return firstUint(await this.evm.contract(this.context.config.addresses.dataCapEvidenceAdapter, this.abi.dataCapEvidenceAdapter).getAllocatedBytes(dealId));
  }

  async dataCapOperational(): Promise<boolean> {
    return Boolean(await this.evm.contract(this.context.config.addresses.dataCapEvidenceAdapter, this.abi.dataCapEvidenceAdapter).isOperational());
  }

  async evidenceStatus(dealId: bigint): Promise<EvidenceStatus> {
    const market = this.evm.contract(this.context.config.addresses.poRepMarket, this.abi.poRepMarket);
    const value = await market.currentEvidenceStatus.staticCall(dealId) as Result;
    return {
      activeCoveredBytes: firstUint(value[0]),
      lastEvidenceRefreshEpoch: firstUint(value[1]),
      reasonCode: firstUint(value[2]),
      result: firstUint(value[3]),
      checkedClaims: firstUint(value[4]),
      totalClaims: firstUint(value[5])
    };
  }

  async sliAttestation(dealId: bigint): Promise<{ lastUpdate: bigint; slis: DealSlis }> {
    const value = await this.evm.contract(this.context.config.addresses.sliOracle, this.abi.sliOracle).getAttestation(dealId) as Result;
    const slis = value[1] as Result;
    return {
      lastUpdate: firstUint(value[0]),
      slis: {
        retrievabilityBps: firstUint(slis[0]),
        bandwidthBytesPerSecond: firstUint(slis[1]),
        latencyMs: firstUint(slis[2]),
        indexingAvailabilityPct: firstUint(slis[3])
      }
    };
  }
}

function resultArrayToBigints(value: unknown): bigint[] {
  if (!Array.isArray(value)) return [];
  return value.map(firstUint);
}
