// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./IPriceOracle.sol";

contract OracleStub is Ownable, IPriceOracle {
    uint256 private price;

    constructor(uint256 initialPrice) Ownable(msg.sender) {
        price = initialPrice;
    }

    function setPrice(uint256 newPrice) external onlyOwner {
        price = newPrice;
    }

    function getPrice() external view override returns (uint256) {
        return price;
    }
}

