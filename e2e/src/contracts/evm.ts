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

  async ensureEvmActor(privateKey: string): Promise<void> {
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
      "1wei",
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

  async waitForTx(txHash: string): Promise<TxReceipt> {
    for (let attempt = 1; attempt <= 60; attempt++) {
      const result = run("cast", ["receipt", "--rpc-url", this.context.config.rpcUrl, txHash, "--json"], this.context.projectRoot);
      const json = jsonFromOutput(result.stdout || result.stderr);
      if (json) {
        const receipt = JSON.parse(json) as TxReceipt;
        if (receipt.status === "0x1") {
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
        if (receipt.status === "0x0") throw new Error(`tx ${txHash} reverted`);
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

export function isStableReceipt(
  first: TxReceipt,
  confirmed: TxReceipt,
): boolean {
  return confirmed.status === "0x1"
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

function jsonFromOutput(output: string): string | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*[{[]/.test(line));
  if (start === -1) return undefined;
  return lines.slice(start).join("\n").trim();
}

function redact(value: string): string {
  return value.replace(/--private-key\s+0x[0-9a-fA-F]+/g, "--private-key REDACTED");
}
