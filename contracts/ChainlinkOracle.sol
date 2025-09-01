// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IPriceOracle.sol";

interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        );
}

/// @title Chainlink-based price oracle for BSC testnet feeds
/// @notice Returns prices scaled to 1e18 precision
contract ChainlinkOracle is IPriceOracle {
    AggregatorV3Interface public immutable feed;
    uint8 private immutable feedDecimals;

    constructor(address feedAddress) {
        require(feedAddress != address(0), "feed zero");
        feed = AggregatorV3Interface(feedAddress);
        feedDecimals = feed.decimals();
    }

    function getPrice() external view override returns (uint256) {
        (, int256 answer,,,) = feed.latestRoundData();
        require(answer > 0, "invalid price");
        uint256 price = uint256(answer);
        if (feedDecimals < 18) {
            return price * (10 ** (18 - feedDecimals));
        }
        return price / (10 ** (feedDecimals - 18));
    }
}
