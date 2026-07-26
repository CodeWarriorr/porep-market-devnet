import { Buffer } from "node:buffer";
import type { ScenarioContext } from "../runtime.js";
import { dockerExecEnv } from "./docker.js";

export type PieceInfo = {
  pieceCid: string;
  pieceCidV2: string;
  pieceSize: bigint;
  pieceCidHex: string;
  pieceCarPath: string;
};

export function generatePieceAndAssertCommp(context: ScenarioContext): PieceInfo {
  console.log("=== Generate V2 piece ===");
  const pieceIndex = BigInt(context.state.get("GENERATED_PIECE_INDEX") ?? "0") + 1n;
  context.state.set("GENERATED_PIECE_INDEX", pieceIndex);
  const safeRunId = context.runId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const pieceDir = `/tmp/porep-market-e2e-${safeRunId}-${pieceIndex}`;
  const providerEnv = { SP_ADDRESS: context.config.provider };
  dockerExecEnv(context, "piece-server", providerEnv, ["mkdir", "-p", pieceDir]);
  const generated = dockerExecEnv(context, "piece-server", providerEnv, [
    "sptool", "toolbox", "mk12-client", "generate-rand-car", "--size", "1500000", pieceDir,
  ]);
  const generatedCarPath = generated.match(/written to:\s+(\S+\.car)/)?.[1];
  if (!generatedCarPath) throw new Error(`sptool did not report the generated CAR path\n${generated}`);

  const commpV1 = dockerExecEnv(
    context,
    "piece-server",
    providerEnv,
    ["sptool", "toolbox", "mk12-client", "commp", generatedCarPath],
  );
  const commpV2 = dockerExecEnv(
    context,
    "piece-server",
    providerEnv,
    ["sptool", "toolbox", "mk20-client", "commp", generatedCarPath],
  );
  const pieceCid = commpV1.match(/^CommP CID:\s+(\S+)/m)?.[1];
  const pieceSize = commpV1.match(/^Piece size:\s+(\d+)/m)?.[1];
  const pieceCidV2 = commpV2.match(/^CommP CID:\s+(\S+)/m)?.[1];

  if (!pieceCid || !pieceSize || !pieceCidV2) {
    throw new Error(`failed to compute CommP from ${generatedCarPath}\n${commpV1}\n${commpV2}`);
  }
  if (pieceCid.startsWith("Qm")) {
    throw new Error(`CIDv0 input ${pieceCid} is not supported; expected CIDv1`);
  }

  const pieceCarPath = `/var/lib/curio-client/data/${pieceCidV2}`;
  dockerExecEnv(context, "piece-server", providerEnv, [
    "mkdir", "-p", "/var/lib/curio-client/data",
  ]);
  dockerExecEnv(context, "piece-server", providerEnv, ["mv", generatedCarPath, pieceCarPath]);

  const pieceCidHex = cidToHex(pieceCid);
  context.state.set("PIECE_CID", pieceCid);
  context.state.set("PIECE_CID_V2", pieceCidV2);
  context.state.set("PIECE_SIZE", pieceSize);
  context.state.set("PIECE_CID_HEX", pieceCidHex);
  context.state.set("PIECE_CAR_PATH", pieceCarPath);

  console.log(`  CIDv1: ${pieceCid}`);
  console.log(`  CIDv2: ${pieceCidV2}`);
  console.log(`  Size: ${pieceSize}`);
  console.log("=== V2 piece ready in piece server ===");

  return { pieceCid, pieceCidV2, pieceSize: BigInt(pieceSize), pieceCidHex, pieceCarPath };
}

function cidToHex(cid: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of cid.slice(1).toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value < 0) throw new Error(`unsupported base32 character in piece CID: ${char}`);
    bits += value.toString(2).padStart(5, "0");
  }

  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes).toString("hex");
}
