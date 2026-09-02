import assert from "node:assert/strict";
import test from "node:test";
import { AbiCoder, keccak256 } from "ethers";
import {
  buildSectorEvidencePieceSet,
  SECTOR_EVIDENCE_EMPTY_DOMAIN,
  SECTOR_EVIDENCE_LEAF_DOMAIN,
  SECTOR_EVIDENCE_NODE_DOMAIN,
  SECTOR_EVIDENCE_VERSION,
  sectorEvidenceNotificationPayloadHex,
} from "../src/fixtures/sectorEvidencePieceSet.js";

const PIECES = [
  { pieceCidDigest: `0x${"11".repeat(32)}`, paddedSize: 128n },
  { pieceCidDigest: `0x${"22".repeat(32)}`, paddedSize: 256n },
];

test("Sector evidence piece-set builder uses the fixed v1 two-piece vector", () => {
  const commitment = buildSectorEvidencePieceSet(PIECES);

  assert.equal(commitment.version, 1);
  assert.equal(commitment.requestedSizeBytes, 384n);
  assert.equal(commitment.pieces.length, 2);
  assert.deepEqual(commitment.pieces.map((piece) => piece.pieceIndex), [0, 1]);
  assert.equal(commitment.proofs.every((proof) => proof.length === 1), true);
  assert.equal(commitment.merkleRoot, "0x05613c7fe68a92c02e6921b5ff6fb851c700b4daf9acd85e583c6d073213aec9");
  assert.equal(commitment.manifestHash, "0xf4ee2025495c6097306d770bbcdb4141ad797344b7cbad0d51681addbd887699");
  assert.equal(
    sectorEvidenceNotificationPayloadHex(7n, commitment.pieces[0]!.pieceIndex, commitment.pieces.length, commitment.proofs[0]!),
    "0x0000000000000000000000000000000000000000000000000000000000000007"
      + "0000000000000000000000000000000000000000000000000000000000000000"
      + "0000000000000000000000000000000000000000000000000000000000000002"
      + "0000000000000000000000000000000000000000000000000000000000000080"
      + "0000000000000000000000000000000000000000000000000000000000000001"
      + "edc035b821e84e0482006816069b1cc6b5a20171ac9d5ff1d5252e91e40f6d2f",
  );
});

test("Sector evidence piece-set builder canonicalizes order and rejects duplicate rows", () => {
  const forward = buildSectorEvidencePieceSet(PIECES);
  const reverse = buildSectorEvidencePieceSet([...PIECES].reverse());

  assert.equal(forward.manifestHash, reverse.manifestHash);
  assert.throws(
    () => buildSectorEvidencePieceSet([PIECES[0]!, PIECES[0]!]),
    /duplicate piece-set row/,
  );
});

test("Sector evidence piece-set builder matches fixed one, three, and ten-piece vectors", () => {
  const one = buildSectorEvidencePieceSet([PIECES[0]!]);
  const three = buildSectorEvidencePieceSet([...PIECES, { pieceCidDigest: `0x${"33".repeat(32)}`, paddedSize: 512n }]);
  const ten = buildSectorEvidencePieceSet(scaleRows(10));
  assert.equal(one.manifestHash, "0xb61dd264461b3cdd244113ac78b02b1e851b311909242cc15230e4a88c0e75b3");
  assert.equal(three.manifestHash, "0x9b09a902598a2e1320b33cebf3c66f4fc6c4afe230ec4550a8053bbef66673c9");
  assert.equal(ten.merkleRoot, "0xc04c1106153dd536ff6434ee8c87bbd70ed1a0f7eedb6f3b8ad922ce166da459");
  assert.equal(ten.manifestHash, "0x80fc895d1597a0e5585f24048c5da56ac073f89865eee9caacea1d2ac3e0483f");
});

test("Sector evidence piece-set builder matches generated 64 and 1393 vectors", () => {
  const sixtyFour = buildSectorEvidencePieceSet(scaleRows(64));
  const large = buildSectorEvidencePieceSet(scaleRows(1393));
  assert.equal(sixtyFour.manifestHash, "0x1d7ce09d1eee8279a67687ac7d7ba55ea456144989ecbe714c574dc3d6fe65e1");
  assert.equal(large.manifestHash, "0xb9ea0e43cbe5534b7b72727302701b423f32f3f89507d64f60e868a689bd52ac");
  assert.equal(large.proofs[0]!.length, 11);
});

test("Sector evidence piece-set builder creates every padded five-piece proof bottom-up", () => {
  const pieces = [1, 2, 3, 4, 5].map((byte, index) => ({
    pieceCidDigest: `0x${byte.toString(16).padStart(2, "0").repeat(32)}`,
    paddedSize: BigInt((index + 1) * 2_048),
  }));
  const commitment = buildSectorEvidencePieceSet(pieces);
  const expectedLeaves = commitment.pieces.map((piece) => independentLeaf(piece.pieceIndex, piece.pieceCidDigest, piece.paddedSize));
  const emptyLeaf = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint8"],
    [SECTOR_EVIDENCE_EMPTY_DOMAIN, SECTOR_EVIDENCE_VERSION],
  ));

  assert.equal(commitment.proofs.every((proof) => proof.length === 3), true);
  assert.equal(commitment.proofs[4]![0], emptyLeaf, "last real leaf is paired with empty padding");
  for (const [pieceIndex, proof] of commitment.proofs.entries()) {
    assert.equal(
      independentRoot(expectedLeaves[pieceIndex]!, pieceIndex, proof),
      commitment.merkleRoot,
      `proof for piece ${pieceIndex} reconstructs the root with ordered directions`,
    );
  }
});

test("Sector evidence payload validates fixed ABI framing and malformed inputs", () => {
  const commitment = buildSectorEvidencePieceSet(PIECES);
  const payload = sectorEvidenceNotificationPayloadHex(7n, 0, 2, commitment.proofs[0]!);

  assert.equal(payload.length, 2 + 2 * (160 + 32));
  assert.throws(
    () => sectorEvidenceNotificationPayloadHex(7n, 2, 2, commitment.proofs[0]!),
    /piece index must be smaller than piece count/,
  );
  assert.throws(() => sectorEvidenceNotificationPayloadHex(7n, 0, 3, commitment.proofs[0]!), /proof length/);
  assert.throws(() => buildSectorEvidencePieceSet([{ pieceCidDigest: "0x12", paddedSize: 128n }]), /bytes32/);
  assert.throws(() => buildSectorEvidencePieceSet([{ pieceCidDigest: PIECES[0]!.pieceCidDigest, paddedSize: 0n }]), /positive/);
});

function scaleRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    pieceCidDigest: `0x${BigInt(index + 1).toString(16).padStart(64, "0")}`,
    paddedSize: 128n,
  }));
}

function independentLeaf(pieceIndex: number, pieceCidDigest: string, paddedSize: bigint): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "uint8", "uint32", "bytes32", "uint64"],
    [SECTOR_EVIDENCE_LEAF_DOMAIN, SECTOR_EVIDENCE_VERSION, pieceIndex, pieceCidDigest, paddedSize],
  ));
}

function independentRoot(leaf: string, pieceIndex: number, proof: string[]): string {
  return proof.reduce((current, sibling, level) => {
    const ordered = (pieceIndex & (1 << level)) === 0 ? [current, sibling] : [sibling, current];
    return keccak256(AbiCoder.defaultAbiCoder().encode(
      ["bytes32", "bytes32", "bytes32"],
      [SECTOR_EVIDENCE_NODE_DOMAIN, ...ordered],
    ));
  }, leaf);
}
