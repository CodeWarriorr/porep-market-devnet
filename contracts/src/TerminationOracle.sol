// SPDX-License-Identifier: MIT
pragma solidity =0.8.30;

interface IDataCapTerminationReceiver {
    function claimsTerminatedEarly(uint64[] calldata claims) external;
}

contract TerminationOracle {
    function report(address adapter, uint64[] calldata claims) external {
        IDataCapTerminationReceiver(adapter).claimsTerminatedEarly(claims);
    }
}
