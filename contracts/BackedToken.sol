// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./OracleStub.sol";

interface IBridge {
    /// @notice Transfer `amount` of `token` to the bridge.
    function sendStable(address token, uint256 amount) external;

    /// @notice Send an arbitrary message through the bridge.
    function sendMessage(bytes calldata message) external;
}

contract BackedToken is ERC20, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant PRICE_PRECISION = 1e18;

    IERC20 public immutable stablecoin;
    OracleStub public oracle;
    IBridge public bridge;

    constructor(
        address stablecoinAddress,
        address oracleAddress,
        address bridgeAddress
    ) ERC20("Backed Token", "BKT") Ownable(msg.sender) {
        stablecoin = IERC20(stablecoinAddress);
        oracle = OracleStub(oracleAddress);
        bridge = IBridge(bridgeAddress);
    }

    /// @notice Buy tokens with the underlying stablecoin.
    /// @param stableAmount Amount of stablecoin to spend.
    function buy(uint256 stableAmount) external {
        require(stableAmount > 0, "amount zero");

        uint256 price = oracle.getPrice();
        require(price > 0, "invalid price");

        uint256 tokenAmount = (stableAmount * PRICE_PRECISION) / price;

        // Move stablecoin to this contract then forward it through the bridge.
        stablecoin.safeTransferFrom(msg.sender, address(this), stableAmount);
        stablecoin.safeIncreaseAllowance(address(bridge), stableAmount);
        bridge.sendStable(address(stablecoin), stableAmount);
        _mint(msg.sender, tokenAmount);
    }

    /// @notice Redeem tokens for the underlying stablecoin through the bridge.
    /// @param tokenAmount Amount of tokens to redeem.
    function redeem(uint256 tokenAmount) external {
        require(tokenAmount > 0, "amount zero");

        uint256 price = oracle.getPrice();
        require(price > 0, "invalid price");

        uint256 stableAmount = (tokenAmount * price) / PRICE_PRECISION;

        _burn(msg.sender, tokenAmount);
        bridge.sendMessage(abi.encode(msg.sender, stableAmount));
    }
}

