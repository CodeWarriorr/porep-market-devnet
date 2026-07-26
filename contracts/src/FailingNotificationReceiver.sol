// SPDX-License-Identifier: MIT
pragma solidity =0.8.30;

import {NotificationReceiver} from "./NotificationReceiver.sol";

contract FailingNotificationReceiver is NotificationReceiver {
    constructor(address miner) NotificationReceiver(miner) {}

    function _acceptsPiece() internal pure override returns (bool) {
        return false;
    }
}
