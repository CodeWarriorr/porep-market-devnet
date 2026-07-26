// SPDX-License-Identifier: MIT
pragma solidity =0.8.30;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {NotificationReceiver} from "../src/NotificationReceiver.sol";
import {FailingNotificationReceiver} from "../src/FailingNotificationReceiver.sol";
import {
    FVMSectorContentChanged,
    PieceChange,
    SectorChanges,
    SectorContentChangedParams
} from "fvm-solidity/FVMSectorContentChanged.sol";

contract HarnessContractsTest is Test {
    address internal constant MINER = address(0x1234);
    bytes32 internal constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    function testMockUSDCUsesSixDecimalsAndMints() public {
        MockUSDC token = new MockUSDC();
        token.mint(address(this), 2_000_000);
        assertEq(token.decimals(), 6);
        assertEq(token.balanceOf(address(this)), 2_000_000);
    }

    function testMockUSDCReceiveWithAuthorization() public {
        MockUSDC token = new MockUSDC();
        uint256 payerKey = 0xA11CE;
        address payer = vm.addr(payerKey);
        address payee = address(0xB0B);
        uint256 amount = 1_000_000;
        uint256 validAfter = block.timestamp - 1;
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = keccak256("receive-1");
        token.mint(payer, amount);

        bytes32 structHash =
            keccak256(abi.encode(RECEIVE_TYPEHASH, payer, payee, amount, validAfter, validBefore, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(payerKey, digest);

        vm.prank(payee);
        token.receiveWithAuthorization(
            payer, payee, amount, validAfter, validBefore, nonce, v, r, s
        );
        assertEq(token.balanceOf(payee), amount);
        assertTrue(token.authorizationState(payer, nonce));
    }

    function testNotificationReceiverRecordsExpectedMinerCall() public {
        NotificationReceiver receiver = new NotificationReceiver(MINER);
        bytes32 digest = keccak256("piece");
        bytes memory payload = hex"01020304";
        bytes memory params = _notificationParams(17, 900, digest, 2_097_152, payload);
        vm.prank(MINER);
        (uint32 exitCode, uint64 codec, bytes memory response) =
            receiver.handle_filecoin_method(2034386435, 0x51, params);
        assertEq(exitCode, 0);
        assertEq(codec, 0x51);
        assertEq(response, hex"8181f5");
        assertEq(receiver.calls(), 1);
        assertEq(receiver.uniquePieces(), 1);
        assertEq(receiver.lastParams(), params);
        assertEq(receiver.lastSector(), 17);
        assertEq(receiver.lastMinimumCommitmentEpoch(), 900);
        assertEq(receiver.lastPieceDigest(), digest);
        assertEq(receiver.lastPaddedSize(), 2_097_152);
        assertEq(receiver.lastPayload(), payload);

        vm.prank(MINER);
        receiver.handle_filecoin_method(2034386435, 0x51, params);
        assertEq(receiver.calls(), 2);
        assertEq(receiver.uniquePieces(), 1);
    }

    function testNotificationReceiverRejectsAnotherCaller() public {
        NotificationReceiver receiver = new NotificationReceiver(MINER);
        vm.expectRevert("unexpected miner");
        receiver.handle_filecoin_method(2034386435, 0x51, hex"8180");
    }

    function testNotificationReceiverAcceptsMultiplePiecesInOneSector() public {
        NotificationReceiver receiver = new NotificationReceiver(MINER);
        bytes memory params = _twoPieceNotificationParams();
        vm.prank(MINER);
        (, , bytes memory response) =
            receiver.handle_filecoin_method(2034386435, 0x51, params);
        assertEq(response, hex"8182f5f5");
        assertEq(receiver.calls(), 1);
        assertEq(receiver.uniquePieces(), 2);
        assertEq(receiver.lastSector(), 17);
        assertEq(receiver.lastPieceDigest(), keccak256("piece-2"));
        assertEq(receiver.lastPayload(), hex"02");
    }

    function testRejectedReceiverReturnsRejectedPiece() public {
        FailingNotificationReceiver receiver = new FailingNotificationReceiver(MINER);
        vm.prank(MINER);
        (, , bytes memory response) =
            receiver.handle_filecoin_method(2034386435, 0x51, _notificationParams(17, 900, keccak256("piece"), 2_097_152, hex"01"));
        assertEq(response, hex"8181f4");
    }

    function _notificationParams(
        uint64 sector,
        int64 minimumCommitmentEpoch,
        bytes32 digest,
        uint64 paddedSize,
        bytes memory payload
    ) internal pure returns (bytes memory) {
        PieceChange[] memory pieces = new PieceChange[](1);
        pieces[0] = PieceChange({
            data: abi.encodePacked(hex"0181e203922020", digest),
            size: paddedSize,
            payload: payload
        });
        SectorChanges[] memory sectors = new SectorChanges[](1);
        sectors[0] = SectorChanges({
            sector: sector,
            minimumCommitmentEpoch: minimumCommitmentEpoch,
            added: pieces
        });
        return FVMSectorContentChanged.encodeParams(SectorContentChangedParams({sectors: sectors}));
    }

    function _twoPieceNotificationParams() internal pure returns (bytes memory) {
        PieceChange[] memory pieces = new PieceChange[](2);
        pieces[0] = PieceChange({
            data: abi.encodePacked(hex"0181e203922020", keccak256("piece-1")),
            size: 2_097_152,
            payload: hex"01"
        });
        pieces[1] = PieceChange({
            data: abi.encodePacked(hex"0181e203922020", keccak256("piece-2")),
            size: 2_097_152,
            payload: hex"02"
        });
        SectorChanges[] memory sectors = new SectorChanges[](1);
        sectors[0] = SectorChanges({
            sector: 17,
            minimumCommitmentEpoch: 900,
            added: pieces
        });
        return FVMSectorContentChanged.encodeParams(SectorContentChangedParams({sectors: sectors}));
    }
}
