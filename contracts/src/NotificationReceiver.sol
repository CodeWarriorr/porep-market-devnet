// SPDX-License-Identifier: MIT
pragma solidity =0.8.30;

import {CalldataUtils} from "fvm-solidity/CalldataUtils.sol";
import {
    FVMSectorContentChanged,
    PieceChangeIter,
    SectorChangesHeader,
    SectorContentChangedReturn,
    SectorReturn
} from "fvm-solidity/FVMSectorContentChanged.sol";

contract NotificationReceiver {
    uint64 internal constant SECTOR_CONTENT_CHANGED = 2034386435;
    uint64 internal constant CBOR_CODEC = 0x51;

    address public immutable expectedMiner;
    uint256 public calls;
    uint256 public uniquePieces;
    bytes public lastParams;
    uint64 public lastSector;
    int64 public lastMinimumCommitmentEpoch;
    bytes32 public lastPieceDigest;
    uint64 public lastPaddedSize;
    bytes public lastPayload;
    mapping(bytes32 observationKey => bool observed) public observed;

    event PieceObserved(
        uint64 indexed sector,
        bytes32 indexed pieceDigest,
        uint64 paddedSize,
        int64 minimumCommitmentEpoch,
        bytes payload
    );

    constructor(address miner) {
        expectedMiner = miner;
    }

    function handle_filecoin_method(uint64 method, uint64 codec, bytes calldata params)
        external
        returns (uint32 exitCode, uint64 returnCodec, bytes memory returnData)
    {
        require(msg.sender == expectedMiner, "unexpected miner");
        require(method == SECTOR_CONTENT_CHANGED, "unexpected method");
        require(codec == CBOR_CODEC, "unexpected codec");
        calls++;
        lastParams = params;

        (uint256 sectorCount, uint256 offset) = FVMSectorContentChanged.readParamsHeader();
        SectorContentChangedReturn memory result;
        result.sectors = new SectorReturn[](sectorCount);
        SectorChangesHeader memory sector;
        PieceChangeIter memory piece;
        for (uint256 i = 0; i < sectorCount; i++) {
            offset = FVMSectorContentChanged.readSectorHeader(offset, sector);
            FVMSectorContentChanged.initSectorReturn(result.sectors[i], sector.numPieces);
            for (uint256 j = 0; j < sector.numPieces; j++) {
                offset = FVMSectorContentChanged.readPiece(offset, piece);
                bytes memory payload = CalldataUtils.load(piece.payload);
                bytes32 observationKey =
                    keccak256(abi.encode(sector.sector, piece.digest, piece.paddedSize, payload));
                if (!observed[observationKey]) {
                    observed[observationKey] = true;
                    uniquePieces++;
                    lastSector = sector.sector;
                    lastMinimumCommitmentEpoch = sector.minimumCommitmentEpoch;
                    lastPieceDigest = piece.digest;
                    lastPaddedSize = piece.paddedSize;
                    lastPayload = payload;
                    emit PieceObserved(
                        sector.sector,
                        piece.digest,
                        piece.paddedSize,
                        sector.minimumCommitmentEpoch,
                        payload
                    );
                }
                if (_acceptsPiece()) FVMSectorContentChanged.accept(result.sectors[i], j);
            }
        }

        return (0, CBOR_CODEC, FVMSectorContentChanged.encodeReturn(result));
    }

    function _acceptsPiece() internal pure virtual returns (bool) {
        return true;
    }
}
