// SPDX-License-Identifier: MIT
pragma solidity =0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {DataCapTypes} from "filecoin-solidity/v0.8/types/DataCapTypes.sol";
import {FilAddresses} from "filecoin-solidity/v0.8/utils/FilAddresses.sol";
import {BigInts} from "filecoin-solidity/v0.8/utils/BigInts.sol";
import {CBOR} from "solidity-cborutils/contracts/CBOR.sol";
import {FilecoinCBOR} from "filecoin-solidity/v0.8/cbor/FilecoinCbor.sol";
import {IDataCapEvidenceAdapter} from "src/interfaces/IDataCapEvidenceAdapter.sol";

contract ComputeDataCapBatchCalldata is Script {
    function run() external view {
        uint64 provider = uint64(vm.envOr("PROVIDER", uint256(1000)));
        uint64 pieceSize = uint64(vm.envOr("PIECE_SIZE", uint256(2048)));
        uint256 dealId = vm.envOr("DEAL_ID", uint256(1));
        int64 expiration = int64(uint64(vm.envOr("ALLOCATION_EXPIRATION", block.number + 100000)));
        bytes memory pieceCid = vm.envBytes("PIECE_CID_HEX");
        bytes memory operatorData =
            _buildOperatorData(provider, pieceCid, pieceSize, 518400, 5256000, expiration);
        DataCapTypes.TransferParams memory params = DataCapTypes.TransferParams({
            to: FilAddresses.fromActorID(6),
            amount: BigInts.fromUint256(uint256(pieceSize) * 1 ether),
            operator_data: operatorData
        });
        bytes memory callData =
            abi.encodeCall(IDataCapEvidenceAdapter.submitDataCapBatch, (params, dealId));
        console.log("CALLDATA=%s", vm.toString(callData));
    }

    function _buildOperatorData(
        uint64 provider,
        bytes memory pieceCid,
        uint64 size,
        int64 termMin,
        int64 termMax,
        int64 expiration
    ) internal pure returns (bytes memory) {
        CBOR.CBORBuffer memory buf = CBOR.create(128);
        CBOR.startFixedArray(buf, 2);
        CBOR.startFixedArray(buf, 1);
        CBOR.startFixedArray(buf, 6);
        CBOR.writeUInt64(buf, provider);
        FilecoinCBOR.writeCid(buf, pieceCid);
        CBOR.writeUInt64(buf, size);
        CBOR.writeInt64(buf, termMin);
        CBOR.writeInt64(buf, termMax);
        CBOR.writeInt64(buf, expiration);
        CBOR.startFixedArray(buf, 0);
        return CBOR.data(buf);
    }
}
