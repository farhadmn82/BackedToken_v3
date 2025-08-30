// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./PriceStrategy.sol";
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

    uint8 private constant ACTION_BUY = 0;
    uint8 private constant ACTION_REDEEM = 1;

    string public constant NAME = "Backed Token";
    string public constant SYMBOL = "BKT";

    /// @notice Maximum number of queued redemptions to process per call.
    uint256 private constant MAX_REDEMPTIONS_PER_CALL = 5;

    IERC20 public immutable stablecoin;
    PriceStrategy public priceStrategy;
    IBridge public bridge;

    /// @notice Maximum stablecoin amount to retain before forwarding to the bridge.
    uint256 public bufferThreshold;

    /// @notice Minimum amount of stablecoin to send to the bridge.
    uint256 public minBridgeAmount;

    using RedemptionQueue for RedemptionQueue.Queue;

    RedemptionQueue.Queue private redemptionQueue;

    event TokensBought(address indexed buyer, uint256 stableAmount, uint256 tokenAmount);
    event TokensRedeemed(address indexed redeemer, uint256 tokenAmount, uint256 stableAmount);
    event BufferThresholdUpdated(uint256 newThreshold);
    event MinBridgeAmountUpdated(uint256 newMin);

    constructor(
        address stablecoinAddress,
        address priceStrategyAddress,
        address bridgeAddress
    ) ERC20(NAME, SYMBOL) Ownable(msg.sender) {
        stablecoin = IERC20(stablecoinAddress);
        priceStrategy = PriceStrategy(priceStrategyAddress);
        bridge = IBridge(bridgeAddress);
    }

    /// @notice Set the price strategy module.
    function setPriceStrategy(address strategy) external onlyOwner {
        priceStrategy = PriceStrategy(strategy);
    }

    /// @notice Set the buffer threshold used when accumulating stablecoins.
    function setBufferThreshold(uint256 threshold) external onlyOwner {
        bufferThreshold = threshold;
        emit BufferThresholdUpdated(threshold);
    }

    /// @notice Set the minimum amount of stablecoin to send through the bridge.
    function setMinBridgeAmount(uint256 amount) external onlyOwner {
        minBridgeAmount = amount;
        emit MinBridgeAmountUpdated(amount);
    }

    /// @notice Deposit stablecoins into the local liquidity buffer.
    function depositBuffer(uint256 amount) external onlyOwner {
        require(amount > 0, "amount zero");
        stablecoin.safeTransferFrom(msg.sender, address(this), amount);
        _processRedemptions(address(0), 0);
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
    function _processRedemptions(address redeemer, uint256 amount) internal {
        RedemptionQueue.Redeem[] memory payouts = redemptionQueue.process(
            redeemer,
            amount,
            stablecoin.balanceOf(address(this)),
            MAX_REDEMPTIONS_PER_CALL
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

    /// @dev Send a message to the bridge for off-chain processing.
    function _sendBridgeMessage(
        uint8 action,
        address participant,
        uint256 amount
    ) internal {
        bytes memory message = abi.encode(action, participant, amount);
        bridge.sendMessage(message);
    }

    /// @notice Buy tokens with the underlying stablecoin.
    /// @param stableAmount Amount of stablecoin to spend.
    function buy(uint256 stableAmount) external {
        require(stableAmount > 0, "amount zero");

        (uint256 price, uint256 fee) = priceStrategy.buyPrice();
        require(price > 0, "invalid price");
        require(stableAmount > fee, "amount too small");

        uint256 netAmount = stableAmount - fee;
        uint256 tokenAmount = (netAmount * PRICE_PRECISION) / price;

        // Move stablecoin to this contract first and verify full amount received.
        uint256 balanceBefore = stablecoin.balanceOf(address(this));
        stablecoin.safeTransferFrom(msg.sender, address(this), stableAmount);
        uint256 received = stablecoin.balanceOf(address(this)) - balanceBefore;
        require(received == stableAmount, "stablecoin mismatch");

        if (fee > 0) {
            stablecoin.safeTransfer(priceStrategy.feeCollector(), fee);
        }

        _sendBridgeMessage(ACTION_BUY, msg.sender, netAmount);

        // Settle queued redemptions and forward any excess liquidity.
        _processRedemptions(address(0), 0);
        forwardExcessToBridge();
        _mint(msg.sender, tokenAmount);
        emit TokensBought(msg.sender, netAmount, tokenAmount);
    }

    /// @notice Redeem tokens for the underlying stablecoin through the bridge.
    /// @param tokenAmount Amount of tokens to redeem.
    function redeem(uint256 tokenAmount) external {
        require(tokenAmount > 0, "amount zero");

        (uint256 price, uint256 fee) = priceStrategy.redeemPrice();
        require(price > 0, "invalid price");

        uint256 stableAmount = (tokenAmount * price) / PRICE_PRECISION;
        require(stableAmount > fee, "amount too small");
        uint256 netAmount = stableAmount - fee;

        _burn(msg.sender, tokenAmount);

        if (fee > 0) {
            stablecoin.safeTransfer(priceStrategy.feeCollector(), fee);
        }

        _sendBridgeMessage(ACTION_REDEEM, msg.sender, netAmount);
        _processRedemptions(msg.sender, netAmount);
        emit TokensRedeemed(msg.sender, tokenAmount, netAmount);
    }
}

