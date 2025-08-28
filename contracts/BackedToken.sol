// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./OracleStub.sol";
import "./RedemptionQueue.sol";

interface IBridge {
    /// @notice Transfer `amount` of `token` to the bridge.
    function sendStable(address token, uint256 amount) external;

    /// @notice Send an arbitrary message through the bridge.
    function sendMessage(bytes calldata message) external;
}

contract BackedToken is ERC20, Ownable {
    using SafeERC20 for IERC20;

    uint256 private constant PRICE_PRECISION = 1e18;

    string public constant NAME = "Backed Token";
    string public constant SYMBOL = "BKT";

    IERC20 public immutable stablecoin;
    OracleStub public oracle;
    IBridge public bridge;

    /// @notice Maximum stablecoin amount to retain before forwarding to the bridge.
    uint256 public bufferThreshold;

    /// @notice Minimum amount of stablecoin to send to the bridge.
    uint256 public minBridgeAmount;

    using RedemptionQueue for RedemptionQueue.Queue;

    RedemptionQueue.Queue private redemptionQueue;

    constructor(
        address stablecoinAddress,
        address oracleAddress,
        address bridgeAddress
    ) ERC20(NAME, SYMBOL) Ownable(msg.sender) {
        stablecoin = IERC20(stablecoinAddress);
        oracle = OracleStub(oracleAddress);
        bridge = IBridge(bridgeAddress);
    }

    /// @notice Set the buffer threshold used when accumulating stablecoins.
    function setBufferThreshold(uint256 threshold) external onlyOwner {
        bufferThreshold = threshold;
    }

    /// @notice Set the minimum amount of stablecoin to send through the bridge.
    function setMinBridgeAmount(uint256 amount) external onlyOwner {
        minBridgeAmount = amount;
    }

    /// @notice Deposit stablecoins into the local liquidity buffer.
    function depositBuffer(uint256 amount) external onlyOwner {
        require(amount > 0, "amount zero");
        stablecoin.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Withdraw stablecoins from the local liquidity buffer.
    function withdrawBuffer(uint256 amount) external onlyOwner {
        require(amount > 0, "amount zero");
        require(stablecoin.balanceOf(address(this)) >= amount, "insufficient buffer");
        stablecoin.safeTransfer(msg.sender, amount);
    }

    function redemptionQueueLength() external view returns (uint256) {
        return redemptionQueue.length();
    }

    /// @notice Process queued redemptions and optionally a new request using
    /// available buffer liquidity.
    /// @param redeemer Address requesting redemption (zero to process queue only).
    /// @param amount Amount requested for redemption.
    function processRedemptions(address redeemer, uint256 amount) public {
        RedemptionQueue.Redeem[] memory payouts = redemptionQueue.process(
            redeemer,
            amount,
            stablecoin.balanceOf(address(this))
        );
        for (uint256 i = 0; i < payouts.length; i++) {
            stablecoin.safeTransfer(payouts[i].redeemer, payouts[i].amount);
        }
    }

    /// @notice Forward excess buffer liquidity to the bridge.
    function forwardExcessToBridge() public {
        uint256 balance = stablecoin.balanceOf(address(this));
        if (balance > bufferThreshold + minBridgeAmount) {
            uint256 toBridge = balance - bufferThreshold;
            stablecoin.safeIncreaseAllowance(address(bridge), toBridge);
            bridge.sendStable(address(stablecoin), toBridge);
        }
    }

    /// @notice Buy tokens with the underlying stablecoin.
    /// @param stableAmount Amount of stablecoin to spend.
    function buy(uint256 stableAmount) external {
        require(stableAmount > 0, "amount zero");

        uint256 price = oracle.getPrice();
        require(price > 0, "invalid price");

        uint256 tokenAmount = (stableAmount * PRICE_PRECISION) / price;

        // Move stablecoin to this contract first.
        stablecoin.safeTransferFrom(msg.sender, address(this), stableAmount);

        // Settle queued redemptions and forward any excess liquidity.
        processRedemptions(address(0), 0);
        forwardExcessToBridge();
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

        processRedemptions(msg.sender, stableAmount);
    }
}

