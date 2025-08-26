// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Simple bridge mock used for tests.
contract BridgeStub {
    using SafeERC20 for IERC20;

    event StableSent(address indexed token, address indexed from, uint256 amount);
    event MessageSent(bytes message);

    /// @notice Simulate sending stablecoins through the bridge.
    function sendStable(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit StableSent(token, msg.sender, amount);
    }

    /// @notice Simulate sending an arbitrary message through the bridge.
    function sendMessage(bytes calldata message) external {
        emit MessageSent(message);
    }

    // ---------------------------------------------------------------------
    // The functions below are placeholders for tests on the receiving side.
    // ---------------------------------------------------------------------

    function receiveStable(address /*token*/, uint256 /*amount*/) external {}

    function receiveMessage(bytes calldata /*message*/) external {}
}

