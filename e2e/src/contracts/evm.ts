import { Contract, ethers, Interface, Wallet, type InterfaceAbi } from "ethers";
import type { ScenarioContext } from "../runtime.js";
import { run, runRequired, sleep } from "../shell.js";
import { ContractRevertError } from "./reverts.js";

export type TxReceipt = {
  transactionHash: string;
  status: string;
  blockHash: string;
  blockNumber: string;
  logs: Array<{ topics: string[]; data: string }>;
};

export type RevertableTxOutcome = {
  receipt: TxReceipt;
  revertData?: string;
};

export type RequestedTransactionEnvelope = {
  from: string;
  to: string;
  input: string;
};

type MinedTransaction = {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  blockHash: string | null;
  blockNumber: string | null;
};

type TransactionTrace = {
  error?: string;
  traceAddress?: unknown;
  result?: unknown;
  blockHash?: string;
  blockNumber?: string | number;
  transactionHash?: string;
};

export class Evm {
  readonly provider: ethers.JsonRpcProvider;
  readonly signerAddress: string;
  readonly spAddress: string;

  constructor(readonly context: ScenarioContext) {
    this.provider = new ethers.JsonRpcProvider(context.config.rpcUrl);
    this.signerAddress = new Wallet(context.config.privateKeyTest).address;
    this.spAddress = new Wallet(context.config.privateKeySp).address;
  }

  contract(address: string, abi: InterfaceAbi): any {
    return new Contract(address, abi, this.provider);
  }

  async send(to: string, signatureOrData: string, args: Array<string | number | bigint | boolean> = []): Promise<string> {
    return await this.sendWithPrivateKey(this.context.config.privateKeyTest, to, signatureOrData, args);
  }

  async sendWithPrivateKey(
    privateKey: string,
    to: string,
    signatureOrData: string,
    args: Array<string | number | bigint | boolean> = []
  ): Promise<string> {
    const castArgs = [
      "send",
      "--gas-limit",
      "9000000000",
      "--rpc-url",
      this.context.config.rpcUrl,
      "--private-key",
      privateKey,
      to,
      signatureOrData,
      ...args.map(String),
      "--json"
    ];
    const result = run("cast", castArgs, this.context.projectRoot);
    const txHash = extractTxHash(result.stdout);
    if (result.status !== 0 || !txHash) {
      throw new Error(`${result.command} failed with ${result.status}\n${redact(result.stderr || result.stdout)}`);
    }
    await this.waitForTx(txHash);
    return txHash;
  }

  async sendWithPrivateKeyAllowRevert(
    privateKey: string,
    to: string,
    signatureOrData: string,
    args: Array<string | number | bigint | boolean> = []
  ): Promise<RevertableTxOutcome> {
    const expectedEnvelope = {
      from: this.addressForPrivateKey(privateKey),
      to,
      input: isCalldata(signatureOrData)
        ? signatureOrData
        : this.calldata(signatureOrData, args),
    };
    const castArgs = [
      "send",
      "--gas-limit",
      "9000000000",
      "--rpc-url",
      this.context.config.rpcUrl,
      "--private-key",
      privateKey,
      to,
      signatureOrData,
      ...args.map(String),
      "--async",
      "--json"
    ];
    const result = run("cast", castArgs, this.context.projectRoot);
    const txHash = extractAsyncTxHash(result.stdout);
    if (result.status !== 0 || !txHash) {
      throw new Error(`${result.command} failed with ${result.status}\n${redact(result.stderr || result.stdout)}`);
    }

    const receipt = await this.waitForTxOutcome(txHash, true);
    const transactionResult = run("cast", [
      "rpc",
      "--rpc-url",
      this.context.config.rpcUrl,
      "eth_getTransactionByHash",
      txHash,
    ], this.context.projectRoot);
    const transactionJson = jsonFromOutput(transactionResult.stdout || transactionResult.stderr);
    if (transactionResult.status !== 0 || !transactionJson) {
      throw new Error(`${transactionResult.command} failed with ${transactionResult.status}\n${redact(transactionResult.stderr || transactionResult.stdout)}`);
    }
    const transaction = JSON.parse(transactionJson) as MinedTransaction | null;
    assertMinedTransactionEnvelope(txHash, receipt, transaction, expectedEnvelope);
    if (receipt.status !== "0x0") return { receipt };

    const traceResult = run("cast", [
      "rpc",
      "--rpc-url",
      this.context.config.rpcUrl,
      "trace_transaction",
      txHash,
    ], this.context.projectRoot);
    const traceJson = jsonFromOutput(traceResult.stdout || traceResult.stderr);
    if (traceResult.status !== 0 || !traceJson) {
      throw new Error(`${traceResult.command} failed with ${traceResult.status}\n${redact(traceResult.stderr || traceResult.stdout)}`);
    }
    const revertData = revertDataFromTransactionTrace(
      txHash,
      receipt,
      JSON.parse(traceJson) as unknown,
    );
    return revertData ? { receipt, revertData } : { receipt };
  }

  async simulate(to: string, signatureOrData: string, args: Array<string | number | bigint | boolean> = []): Promise<string> {
    return await this.simulateWithPrivateKey(this.context.config.privateKeyTest, to, signatureOrData, args);
  }

  async simulateWithPrivateKey(
    privateKey: string,
    to: string,
    signatureOrData: string,
    args: Array<string | number | bigint | boolean> = []
  ): Promise<string> {
    const castArgs = [
      "call",
      "--gas-limit",
      "9000000000",
      "--rpc-url",
      this.context.config.rpcUrl,
      "--from",
      this.addressForPrivateKey(privateKey),
      to,
      signatureOrData,
      ...args.map(String)
    ];
    const result = run("cast", castArgs, this.context.projectRoot);
    if (result.status === 0) return result.stdout.trim();

    const output = result.stderr || result.stdout;
    const revertData = extractRevertData(output);
    if (revertData) throw new ContractRevertError(revertData);
    throw new Error(`${result.command} failed with ${result.status}\n${redact(output)}`);
  }

  addressForPrivateKey(privateKey: string): string {
    return new Wallet(privateKey).address;
  }

  async ensureEvmActor(
    privateKey: string,
    initialBalanceAttoFil: bigint = 1n,
  ): Promise<void> {
    const address = this.addressForPrivateKey(privateKey);
    const probeArgs = [
      "call",
      "--rpc-url",
      this.context.config.rpcUrl,
      "--from",
      address,
      this.context.config.addresses.usdcToken,
      "balanceOf(address)(uint256)",
      address
    ];
    const probe = run("cast", probeArgs, this.context.projectRoot);
    if (probe.status === 0) return;

    const output = probe.stderr || probe.stdout;
    if (!isActorResolutionError(output)) {
      throw new Error(`${probe.command} failed with ${probe.status}\n${redact(output)}`);
    }

    console.log(`  Creating Filecoin actor mapping for ${address}`);
    const funding = run("cast", [
      "send",
      "--gas-limit",
      "9000000000",
      "--rpc-url",
      this.context.config.rpcUrl,
      "--private-key",
      this.context.config.privateKeyTest,
      "--value",
      `${initialBalanceAttoFil}wei`,
      address,
      "--json"
    ], this.context.projectRoot);
    const txHash = extractTxHash(funding.stdout);
    if (funding.status !== 0 || !txHash) {
      throw new Error(`${funding.command} failed with ${funding.status}\n${redact(funding.stderr || funding.stdout)}`);
    }
    await this.waitForTx(txHash);

    const verified = run("cast", probeArgs, this.context.projectRoot);
    if (verified.status !== 0) {
      throw new Error(`${verified.command} failed with ${verified.status}\n${redact(verified.stderr || verified.stdout)}`);
    }
  }

  async sweepNativeBalance(privateKey: string, recipient: string): Promise<void> {
    const wallet = new Wallet(privateKey, this.provider);
    const balance = await this.provider.getBalance(wallet.address);
    if (balance === 0n) return;

    const gasPrice = (await this.provider.getFeeData()).gasPrice;
    if (gasPrice === null) throw new Error("native sweep gas price is unavailable");
    const gasLimit = await this.provider.estimateGas({
      from: wallet.address,
      to: recipient,
      value: 1n,
    });
    const value = nativeSweepValue(balance, gasLimit, gasPrice);
    if (value === 0n) throw new Error(`native sweep balance ${balance} cannot cover its estimated fee`);

    const transaction = await wallet.sendTransaction({
      to: recipient,
      value,
      gasLimit,
      gasPrice,
    });
    await this.waitForTx(transaction.hash);
  }

  async waitForTx(txHash: string): Promise<TxReceipt> {
    const receipt = await this.waitForTxOutcome(txHash);
    if (receipt.status === "0x0") throw new Error(`tx ${txHash} reverted`);
    return receipt;
  }

  private async waitForTxOutcome(
    txHash: string,
    requireStableRevert = false,
  ): Promise<TxReceipt> {
    for (let attempt = 1; attempt <= 60; attempt++) {
      const result = run("cast", ["receipt", "--rpc-url", this.context.config.rpcUrl, txHash, "--json"], this.context.projectRoot);
      const json = jsonFromOutput(result.stdout || result.stderr);
      if (json) {
        const receipt = JSON.parse(json) as TxReceipt;
        if (receipt.status === "0x1" || (receipt.status === "0x0" && requireStableRevert)) {
          const confirmationEpoch = BigInt(receipt.blockNumber) + 2n;
          if (this.blockNumber() >= confirmationEpoch) {
            const confirmation = run(
              "cast",
              ["receipt", "--rpc-url", this.context.config.rpcUrl, txHash, "--json"],
              this.context.projectRoot,
            );
            const confirmationJson = jsonFromOutput(
              confirmation.stdout || confirmation.stderr,
            );
            if (confirmationJson) {
              const confirmed = JSON.parse(confirmationJson) as TxReceipt;
              if (isStableReceipt(receipt, confirmed)) return confirmed;
            }
          }
        }
        if (receipt.status === "0x0" && !requireStableRevert) return receipt;
      }
      if (attempt % 6 === 0) {
        console.log(`  [waitForTx] still waiting for ${txHash.slice(0, 12)}... (${attempt} checks)`);
      }
      await sleep(5000);
    }
    throw new Error(`tx ${txHash} not mined after 5 minutes`);
  }

  receipt(txHash: string): TxReceipt {
    const output = runRequired("cast", ["receipt", "--rpc-url", this.context.config.rpcUrl, txHash, "--json"], this.context.projectRoot);
    return JSON.parse(jsonFromOutput(output) ?? output) as TxReceipt;
  }

  storage(address: string, slot: string): string {
    return runRequired(
      "cast",
      ["storage", "--rpc-url", this.context.config.rpcUrl, address, slot],
      this.context.projectRoot,
    ).trim();
  }

  parseEvent(receipt: TxReceipt, abi: InterfaceAbi, eventName: string): ethers.LogDescription {
    const iface = new Interface(abi);
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (parsed?.name === eventName) return parsed;
      } catch {
        // Receipts often contain logs from other contracts involved in the call.
      }
    }
    throw new Error(`${eventName} event not found in ${receipt.transactionHash}`);
  }

  blockNumber(): bigint {
    return BigInt(runRequired("cast", ["block-number", "--rpc-url", this.context.config.rpcUrl], this.context.projectRoot).split(/\s+/)[0] ?? "0");
  }

  async waitForBlock(target: bigint): Promise<void> {
    let current = this.blockNumber();
    while (current < target) {
      console.log(`  [waitForBlock] waiting for ${target} (${current} / ${target})`);
      await sleep(5000);
      current = this.blockNumber();
    }
  }

  abiEncode(types: string, value: string | number | bigint): string {
    return runRequired("cast", ["abi-encode", types, String(value)], this.context.projectRoot);
  }

  calldata(signature: string, args: Array<string | number | bigint | boolean>): string {
    return runRequired("cast", ["calldata", signature, ...args.map(String)], this.context.projectRoot);
  }
}

export function nativeSweepValue(
  balance: bigint,
  gasLimit: bigint,
  gasPrice: bigint,
): bigint {
  const fee = gasLimit * gasPrice;
  return balance > fee ? balance - fee : 0n;
}

export function isStableReceipt(
  first: TxReceipt,
  confirmed: TxReceipt,
): boolean {
  return (first.status === "0x1" || first.status === "0x0")
    && confirmed.status === first.status
    && confirmed.transactionHash.toLowerCase() === first.transactionHash.toLowerCase()
    && confirmed.blockHash.toLowerCase() === first.blockHash.toLowerCase()
    && confirmed.blockNumber === first.blockNumber;
}

export function firstUint(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value.split(/\s+/)[0] ?? value);
  throw new Error(`cannot convert ${String(value)} to bigint`);
}

export function lower(value: string): string {
  return value.toLowerCase();
}

export function requireAddress(value: string, label: string): string {
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${label}: expected non-zero address, got ${value}`);
  }
  return value;
}

export function extractTxHash(output: string): string | undefined {
  const json = jsonFromOutput(output);
  if (json) {
    const parsed = JSON.parse(json) as { transactionHash?: string };
    if (parsed.transactionHash) return parsed.transactionHash;
  }
  return output.match(/0x[0-9a-fA-F]{64}/g)?.at(-1);
}

export function extractAsyncTxHash(output: string): string | undefined {
  const trimmed = output.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (typeof parsed === "string" && /^0x[0-9a-fA-F]{64}$/.test(parsed)) {
      return parsed;
    }
  } catch {
    // Non-JSON output is rejected below.
  }
  return undefined;
}

export function extractRevertData(output: string): string | undefined {
  const patterns = [
    /["']?data["']?\s*:\s*["']?(0x[0-9a-fA-F]{8,})/i,
    /execution reverted\s*:\s*(0x[0-9a-fA-F]{8,})/i
  ];
  for (const pattern of patterns) {
    const data = pattern.exec(output)?.[1];
    if (data && data.length % 2 === 0) return data;
  }
  return undefined;
}

export function assertMinedTransactionEnvelope(
  broadcastHash: string,
  receipt: TxReceipt,
  transaction: MinedTransaction | null,
  expected: RequestedTransactionEnvelope,
): void {
  if (!transaction) {
    throw new Error(`broadcast transaction ${broadcastHash} was not returned by eth_getTransactionByHash`);
  }
  if (receipt.transactionHash.toLowerCase() !== broadcastHash.toLowerCase()) {
    throw new Error("receipt transaction hash does not match broadcast hash");
  }
  if (transaction.hash.toLowerCase() !== broadcastHash.toLowerCase()) {
    throw new Error("returned transaction hash does not match broadcast hash");
  }
  if (transaction.from.toLowerCase() !== expected.from.toLowerCase()) {
    throw new Error("mined transaction sender does not match requested sender");
  }
  if (transaction.to?.toLowerCase() !== expected.to.toLowerCase()) {
    throw new Error("mined transaction target does not match requested target");
  }
  if (transaction.input.toLowerCase() !== expected.input.toLowerCase()) {
    throw new Error("mined transaction input does not match requested input");
  }
  if (transaction.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    throw new Error("mined transaction block hash does not match receipt");
  }
  if (
    transaction.blockNumber === null
    || BigInt(transaction.blockNumber) !== BigInt(receipt.blockNumber)
  ) {
    throw new Error("mined transaction block number does not match receipt");
  }
}

export function revertDataFromTransactionTrace(
  broadcastHash: string,
  receipt: TxReceipt,
  value: unknown,
): string {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`trace_transaction returned no trace for ${broadcastHash}`);
  }
  const traces = value as TransactionTrace[];
  for (const trace of traces) {
    if (trace.transactionHash?.toLowerCase() !== broadcastHash.toLowerCase()) {
      throw new Error("trace transaction hash does not match broadcast hash");
    }
    if (trace.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      throw new Error("trace block hash does not match receipt");
    }
    if (
      trace.blockNumber === undefined
      || BigInt(trace.blockNumber) !== BigInt(receipt.blockNumber)
    ) {
      throw new Error("trace block number does not match receipt");
    }
  }

  const roots = traces.filter(
    (trace) => Array.isArray(trace.traceAddress) && trace.traceAddress.length === 0,
  );
  if (roots.length !== 1) {
    throw new Error(`trace_transaction returned ${roots.length} root traces for ${broadcastHash}`);
  }
  const root = roots[0]!;
  if (root.error !== "Reverted") {
    throw new Error(`root transaction trace did not revert: ${root.error ?? "missing error"}`);
  }
  const result = root.result;
  if (
    typeof result !== "object"
    || result === null
    || !("output" in result)
    || typeof result.output !== "string"
    || !isCalldata(result.output)
    || result.output.length < 10
  ) {
    throw new Error(`root transaction trace has no ABI revert data for ${broadcastHash}`);
  }
  return result.output;
}

export function isActorResolutionError(output: string): boolean {
  return /resolve address .*actor not found/i.test(output);
}

export async function retryTransientRead<T>(read: () => Promise<T>, waitForNextBlock: () => Promise<void>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isTransientReadError(error)) throw error;
    await waitForNextBlock();
    return await read();
  }
}

function isTransientReadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const rpcError = error as Error & { code?: string; data?: unknown };
  return rpcError.code === "CALL_EXCEPTION" && rpcError.data == null && /missing revert data/i.test(rpcError.message);
}

function isCalldata(value: string): boolean {
  return /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
}

function jsonFromOutput(output: string): string | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*[{[]/.test(line));
  if (start === -1) return undefined;
  return lines.slice(start).join("\n").trim();
}

function redact(value: string): string {
  return value.replace(/--private-key\s+0x[0-9a-fA-F]+/g, "--private-key REDACTED");
}
