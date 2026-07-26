// SPDX-License-Identifier: Apache-2.0 OR MIT
pragma solidity =0.8.30;

// Derived from FilecoinPay test/mocks/MockERC20.sol at
// 755ca20054dae88e9e28dc569e696e822c59907f. The harness changes the name
// and uses six decimals to match USDC.
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC3009} from "filecoin-pay/interfaces/IERC3009.sol";

contract MockUSDC is ERC20, ERC20Permit, IERC3009 {
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    bytes32 private constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 private constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor() ERC20("Devnet USDC", "dUSDC") ERC20Permit("Devnet USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        _useAuthorization(from, value, validAfter, validBefore, nonce, v, r, s, TRANSFER_TYPEHASH, to);
        _transfer(from, to, value);
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(to == msg.sender, "caller must be recipient");
        require(to != address(0) && to != address(this), "invalid recipient");
        _useAuthorization(from, value, validAfter, validBefore, nonce, v, r, s, RECEIVE_TYPEHASH, to);
        _transfer(from, to, value);
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function _useAuthorization(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes32 typehash,
        address to
    ) private {
        require(block.timestamp > validAfter, "authorization not yet valid");
        require(block.timestamp < validBefore, "authorization expired");
        require(!_authorizationStates[from][nonce], "authorization already used");
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(typehash, from, to, value, validAfter, validBefore, nonce))
        );
        require(ECDSA.recover(digest, v, r, s) == from, "invalid signature");
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
    }
}
