import { Contract, ethers, Wallet } from "ethers";
import type { ScenarioContext } from "../runtime.js";
import { artifactAbis } from "./abi.js";

export type PermitSignature = {
  amount: bigint;
  deadline: bigint;
  v: number;
  r: string;
  s: string;
};

export async function signDepositPermit(
  context: ScenarioContext,
  spender: string,
  amountHuman: string
): Promise<PermitSignature> {
  const provider = new ethers.JsonRpcProvider(context.config.rpcUrl);
  const signer = new Wallet(context.config.privateKeyTest, provider);
  const token = new Contract(context.config.addresses.usdcToken, artifactAbis(context).erc20Permit, provider) as any;
  const [nonce, name, network] = await Promise.all([
    token.nonces(signer.address) as Promise<bigint>,
    token.name() as Promise<string>,
    provider.getNetwork()
  ]);
  const amount = ethers.parseUnits(amountHuman, 6);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const signature = ethers.Signature.from(await signer.signTypedData(
    { name, version: "1", chainId: network.chainId, verifyingContract: context.config.addresses.usdcToken },
    {
      Permit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" }
      ]
    },
    { owner: signer.address, spender, value: amount, nonce, deadline }
  ));

  return { amount, deadline, v: signature.v, r: signature.r, s: signature.s };
}
