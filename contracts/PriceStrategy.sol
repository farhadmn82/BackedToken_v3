// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./OracleStub.sol";

/// @notice Pricing module handling spreads and fixed fees around an oracle price.
contract PriceStrategy is Ownable {
    uint256 private constant PRECISION = 1e18;

    OracleStub public oracle;
    address public feeCollector;

    uint256 public buySpread; // e.g. 0.01 * 1e18 for 1%
    uint256 public redeemSpread; // e.g. 0.01 * 1e18 for 1%
    uint256 public buyFee; // fixed stablecoin amount
    uint256 public redeemFee; // fixed stablecoin amount

    event FeeCollectorUpdated(address newCollector);
    event BuySpreadUpdated(uint256 newSpread);
    event RedeemSpreadUpdated(uint256 newSpread);
    event BuyFeeUpdated(uint256 newFee);
    event RedeemFeeUpdated(uint256 newFee);

    constructor(address oracleAddress, address feeCollectorAddress) Ownable(msg.sender) {
        oracle = OracleStub(oracleAddress);
        feeCollector = feeCollectorAddress;
    }

    function setFeeCollector(address collector) external onlyOwner {
        feeCollector = collector;
        emit FeeCollectorUpdated(collector);
    }

    function setBuySpread(uint256 spread) external onlyOwner {
        buySpread = spread;
        emit BuySpreadUpdated(spread);
    }

    function setRedeemSpread(uint256 spread) external onlyOwner {
        redeemSpread = spread;
        emit RedeemSpreadUpdated(spread);
    }

    function setBuyFee(uint256 fee) external onlyOwner {
        buyFee = fee;
        emit BuyFeeUpdated(fee);
    }

    function setRedeemFee(uint256 fee) external onlyOwner {
        redeemFee = fee;
        emit RedeemFeeUpdated(fee);
    }

    /// @notice Return buy price per token and fixed fee in stablecoin.
    function buyPrice() public view returns (uint256 price, uint256 fee) {
        uint256 base = oracle.getPrice();
        price = base + (base * buySpread) / PRECISION;
        fee = buyFee;
    }

    /// @notice Return redeem price per token and fixed fee in stablecoin.
    function redeemPrice() public view returns (uint256 price, uint256 fee) {
        uint256 base = oracle.getPrice();
        price = base - (base * redeemSpread) / PRECISION;
        fee = redeemFee;
    }
}

