// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IPriceOracle {
    /// @notice Returns the price of one token in terms of the stablecoin.
    /// @dev The price is scaled by 1e18.
    function price() external view returns (uint256);
}

interface IBridge {
    /// @notice Enqueue a redemption request for `account` of `amount` tokens.
    function enqueueRedemption(address account, uint256 amount) external;
}

contract BackedToken is ERC20, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable stablecoin;
    IPriceOracle public oracle;
    IBridge public bridge;

    constructor(
        address stablecoinAddress,
        address oracleAddress,
        address bridgeAddress
    ) ERC20("Backed Token", "BKT") {
        stablecoin = IERC20(stablecoinAddress);
        oracle = IPriceOracle(oracleAddress);
        bridge = IBridge(bridgeAddress);
    }

    /// @notice Buy tokens with the underlying stablecoin.
    /// @param stableAmount Amount of stablecoin to spend.
    function buy(uint256 stableAmount) external {
        require(stableAmount > 0, "amount zero");

        uint256 price = oracle.price();
        require(price > 0, "invalid price");

        uint256 tokenAmount = (stableAmount * 1e18) / price;

        stablecoin.safeTransferFrom(msg.sender, address(bridge), stableAmount);
        _mint(msg.sender, tokenAmount);
    }

    /// @notice Redeem tokens for the underlying stablecoin through the bridge.
    /// @param tokenAmount Amount of tokens to redeem.
    function redeem(uint256 tokenAmount) external {
        require(tokenAmount > 0, "amount zero");

        _burn(msg.sender, tokenAmount);
        bridge.enqueueRedemption(msg.sender, tokenAmount);
    }
}

