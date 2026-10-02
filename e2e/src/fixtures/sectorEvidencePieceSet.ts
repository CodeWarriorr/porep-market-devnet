import { AbiCoder, keccak256 } from "ethers";

export const SECTOR_EVIDENCE_VERSION = 1;
export const SECTOR_EVIDENCE_LEAF_DOMAIN = "0xde24299ea19a4e461e31a0be02e5c601b2f66c1f3786214aa46f553fde6f7179";
export const SECTOR_EVIDENCE_NODE_DOMAIN = "0xaedbcc7b5d2c40692870fd30607e9e30315a8153c6b3a368ef838aec7de83b5d";
export const SECTOR_EVIDENCE_EMPTY_DOMAIN = "0x678499e9bc60f37870b6a17ee59af33c4f4b303a121e0769acd22450b495ed08";
export const SECTOR_EVIDENCE_COMMITMENT_DOMAIN = "0x30999723613fc3c0c783e4cfe2d089b89c98f5f609e29f18d0c8eefcc99be0b6";

const abi = AbiCoder.defaultAbiCoder();

export type SectorEvidencePiece = {
  pieceCidDigest: string;
  paddedSize: bigint;
};

export type SectorEvidenceIndexedPiece = SectorEvidencePiece & {
  pieceIndex: number;
};

export type SectorEvidencePieceSet = {
  version: number;
  pieces: SectorEvidenceIndexedPiece[];
  requestedSizeBytes: bigint;
  merkleRoot: string;
  manifestHash: string;
  proofs: string[][];
};

export function buildSectorEvidencePieceSet(input: SectorEvidencePiece[]): SectorEvidencePieceSet {
  if (input.length === 0) throw new Error("piece set must not be empty");
  if (input.length > 0xffff_ffff) throw new Error("piece count must fit in uint32");

  const pieces = input.map(validatePiece).sort(comparePieces).map((piece, pieceIndex) => ({
    ...piece,
    pieceIndex,
  }));
  for (let index = 1; index < pieces.length; index += 1) {
    const previous = pieces[index - 1]!;
    const current = pieces[index]!;
    if (previous.pieceCidDigest === current.pieceCidDigest && previous.paddedSize === current.paddedSize) {
      throw new Error("duplicate piece-set row");
    }
  }

  const requestedSizeBytes = pieces.reduce((total, piece) => total + piece.paddedSize, 0n);
  const leafCount = nextPowerOfTwo(pieces.length);
  const emptyLeaf = keccak256(abi.encode(["bytes32", "uint8"], [SECTOR_EVIDENCE_EMPTY_DOMAIN, SECTOR_EVIDENCE_VERSION]));
  let level = pieces.map(leaf).concat(Array.from({ length: leafCount - pieces.length }, () => emptyLeaf));
  const proofs = pieces.map(() => [] as string[]);
  for (let proofLevel = 0; level.length > 1; proofLevel += 1) {
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
      const siblingIndex = (pieceIndex >> proofLevel) ^ 1;
      proofs[pieceIndex]!.push(level[siblingIndex]!);
    }
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(node(level[index]!, level[index + 1]!));
    }
    level = next;
  }
  const merkleRoot = level[0]!;
  const manifestHash = keccak256(abi.encode(
    ["bytes32", "uint8", "uint32", "uint256", "bytes32"],
    [SECTOR_EVIDENCE_COMMITMENT_DOMAIN, SECTOR_EVIDENCE_VERSION, pieces.length, requestedSizeBytes, merkleRoot],
  ));
  return { version: SECTOR_EVIDENCE_VERSION, pieces, requestedSizeBytes, merkleRoot, manifestHash, proofs };
}

export function sectorEvidenceNotificationPayloadHex(
  dealId: bigint,
  pieceIndex: number,
  pieceCount: number,
  proof: string[],
): string {
  if (dealId < 0n || dealId >= 1n << 256n) throw new Error("deal ID must fit in uint256");
  if (!Number.isInteger(pieceCount) || pieceCount < 1 || pieceCount > 0xffff_ffff) {
    throw new Error("piece count must fit in uint32");
  }
  if (!Number.isInteger(pieceIndex) || pieceIndex < 0 || pieceIndex >= pieceCount) {
    throw new Error("piece index must be smaller than piece count");
  }
  const expectedDepth = Math.ceil(Math.log2(pieceCount));
  if (proof.length !== expectedDepth) throw new Error("proof length does not match piece count");
  if (!proof.every((sibling) => /^0x[0-9a-fA-F]{64}$/.test(sibling))) {
    throw new Error("proof contains an invalid bytes32 sibling");
  }
  return abi.encode(["uint256", "uint32", "uint32", "bytes32[]"], [dealId, pieceIndex, pieceCount, proof]);
}

function validatePiece(piece: SectorEvidencePiece): SectorEvidencePiece {
  if (!/^0x[0-9a-fA-F]{64}$/.test(piece.pieceCidDigest)) throw new Error("piece CID digest must be bytes32");
  if (piece.paddedSize < 1n || piece.paddedSize > 0xffff_ffff_ffff_ffffn) {
    throw new Error("padded size must fit in positive uint64");
  }
  return { pieceCidDigest: piece.pieceCidDigest.toLowerCase(), paddedSize: piece.paddedSize };
}

function comparePieces(left: SectorEvidencePiece, right: SectorEvidencePiece): number {
  const digest = left.pieceCidDigest.localeCompare(right.pieceCidDigest);
  if (digest !== 0) return digest;
  return left.paddedSize < right.paddedSize ? -1 : left.paddedSize > right.paddedSize ? 1 : 0;
}

function leaf(piece: SectorEvidenceIndexedPiece): string {
  return keccak256(abi.encode(
    ["bytes32", "uint8", "uint32", "bytes32", "uint64"],
    [SECTOR_EVIDENCE_LEAF_DOMAIN, SECTOR_EVIDENCE_VERSION, piece.pieceIndex, piece.pieceCidDigest, piece.paddedSize],
  ));
}

function node(left: string, right: string): string {
  return keccak256(abi.encode(["bytes32", "bytes32", "bytes32"], [SECTOR_EVIDENCE_NODE_DOMAIN, left, right]));
}

function nextPowerOfTwo(count: number): number {
  let result = 1;
  while (result < count) result *= 2;
  return result;
}
