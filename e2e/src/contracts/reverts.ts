import { Interface, type ErrorDescription, type InterfaceAbi } from "ethers";

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
