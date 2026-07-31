import { Interface, type ErrorDescription, type InterfaceAbi } from "ethers";
import type { Evm } from "./evm.js";

export class ContractRevertError extends Error {
  constructor(readonly data: string) {
    super(`contract call reverted with ${data}`);
  }
}

export function assertCustomError(error: unknown, abi: InterfaceAbi, expectedError: string): ErrorDescription {
  const iface = new Interface(abi);
  const fragment = iface.getError(expectedError);
  if (!fragment) throw new Error(`ABI does not define custom error ${expectedError}`);
  if (!(error instanceof ContractRevertError)) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(`expected ${expectedError}, but error did not contain contract revert data: ${message}`);
  }

  let parsed: ErrorDescription | null = null;
  try {
    parsed = iface.parseError(error.data);
  } catch {
    // The error below reports both the expected selector and the invalid data.
  }
  if (parsed?.name !== expectedError) {
    throw new Error(`expected ${expectedError} (${fragment.selector}), got revert data ${error.data}`);
  }
  return parsed;
}

export async function expectCustomError(
  action: () => Promise<unknown>,
  abi: InterfaceAbi,
  expectedError: string
): Promise<ErrorDescription> {
  try {
    await action();
  } catch (error) {
    return assertCustomError(error, abi, expectedError);
  }
  throw new Error(`expected ${expectedError}, but the call succeeded`);
}

export async function expectRevertOnSend(
  evm: Pick<Evm, "sendWithPrivateKeyAllowRevert">,
  privateKey: string,
  to: string,
  signatureOrData: string,
  args: Array<string | number | bigint | boolean>,
  abi: InterfaceAbi,
  expectedError: string,
): Promise<ErrorDescription> {
  const { receipt, revertData } = await evm.sendWithPrivateKeyAllowRevert(
    privateKey,
    to,
    signatureOrData,
    args,
  );
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(receipt.transactionHash)
    || !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash)
    || !/^0x[0-9a-fA-F]+$/.test(receipt.blockNumber)
  ) {
    throw new Error(`expected ${expectedError}, but the transaction was not mined`);
  }
  if (receipt.status === "0x1") {
    throw new Error(`expected ${expectedError}, but tx ${receipt.transactionHash} succeeded`);
  }
  if (receipt.status !== "0x0") {
    throw new Error(`expected ${expectedError}, but tx ${receipt.transactionHash} has status ${receipt.status}`);
  }
  if (!revertData) {
    throw new Error(`tx ${receipt.transactionHash} was mined and reverted, but no revert data was recovered`);
  }
  return assertCustomError(new ContractRevertError(revertData), abi, expectedError);
}
