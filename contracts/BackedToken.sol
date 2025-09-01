// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./IPriceOracle.sol";
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
    IPriceOracle public oracle;
    address public feeCollector;
    IBridge public bridge;

    /// @notice Address of the off-chain service allowed to forward liquidity.
    address public operator;

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
    event OperatorUpdated(address newOperator);
    event FeeCollectorUpdated(address newCollector);
    event OracleUpdated(address newOracle);
    event BridgeUpdated(address newBridge);
    event PricingParamsUpdated(
        uint256 buySpread,
        uint256 redeemSpread,
        uint256 buyFee,
        uint256 redeemFee
    );

    uint256 public buySpread; // e.g. 0.01 * 1e18 for 1%
    uint256 public redeemSpread; // e.g. 0.01 * 1e18 for 1%
    uint256 public buyFee; // fixed stablecoin amount
    uint256 public redeemFee; // fixed stablecoin amount

    constructor(
        address stablecoinAddress,
        address oracleAddress,
        address feeCollectorAddress,
        address bridgeAddress
    ) ERC20(NAME, SYMBOL) Ownable(msg.sender) {
        require(stablecoinAddress != address(0), "stablecoin zero");
        require(oracleAddress != address(0), "oracle zero");
        require(feeCollectorAddress != address(0), "collector zero");
        require(bridgeAddress != address(0), "bridge zero");
        stablecoin = IERC20(stablecoinAddress);
        oracle = IPriceOracle(oracleAddress);
        feeCollector = feeCollectorAddress;
        bridge = IBridge(bridgeAddress);
    }

    /// @notice Set the fee collector address.
    function setFeeCollector(address collector) external onlyOwner {
        require(collector != address(0), "collector zero");
        feeCollector = collector;
        emit FeeCollectorUpdated(collector);
    }

    /// @notice Set spreads and fees for buy and redeem operations.
    function setPricingParameters(
        uint256 _buySpread,
        uint256 _redeemSpread,
        uint256 _buyFee,
        uint256 _redeemFee
    ) external onlyOwner {
        buySpread = _buySpread;
        redeemSpread = _redeemSpread;
        buyFee = _buyFee;
        redeemFee = _redeemFee;
        emit PricingParamsUpdated(_buySpread, _redeemSpread, _buyFee, _redeemFee);
    }

    /// @notice Set the buffer threshold used when accumulating stablecoins.
    function setBufferThreshold(uint256 threshold) external onlyOwner {
        require(threshold > 0, "threshold zero");
        bufferThreshold = threshold;
        emit BufferThresholdUpdated(threshold);
    }

    /// @notice Set the minimum amount of stablecoin to send through the bridge.
    function setMinBridgeAmount(uint256 amount) external onlyOwner {
        require(amount > 0, "amount zero");
        minBridgeAmount = amount;
        emit MinBridgeAmountUpdated(amount);
    }

    /// @notice Set the oracle contract address.
    function setOracle(address oracleAddress) external onlyOwner {
        require(oracleAddress != address(0), "oracle zero");
        oracle = IPriceOracle(oracleAddress);
        emit OracleUpdated(oracleAddress);
    }

    /// @notice Set the bridge contract address.
    function setBridge(address bridgeAddress) external onlyOwner {
        require(bridgeAddress != address(0), "bridge zero");
        bridge = IBridge(bridgeAddress);
        emit BridgeUpdated(bridgeAddress);
    }

    /// @notice Set the address permitted to forward buffer funds to the bridge.
    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "operator zero");
        operator = newOperator;
        emit OperatorUpdated(newOperator);
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

    /// @notice Exposed handler for the off-chain service to process queued
    /// redemptions or enqueue a new request after buy or redeem events.
    /// @param redeemer Address requesting redemption (zero to process queue only).
    /// @param amount Amount requested for redemption.
    function processRedemptions(address redeemer, uint256 amount)
        external
        onlyOperator
    {
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

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    /// @notice Forward excess buffer liquidity to the bridge.
    function forwardExcessToBridge() external onlyOperator {
        uint256 balance = stablecoin.balanceOf(address(this));
        if (balance > bufferThreshold + minBridgeAmount) {
            uint256 toBridge = balance - bufferThreshold;
            stablecoin.forceApprove(address(bridge), toBridge);
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

    function _buyPrice() internal view returns (uint256 price, uint256 fee) {
        uint256 base = oracle.getPrice();
        price = base + (base * buySpread) / PRICE_PRECISION;
        fee = buyFee;
    }

    function _redeemPrice() internal view returns (uint256 price, uint256 fee) {
        uint256 base = oracle.getPrice();
        price = base - (base * redeemSpread) / PRICE_PRECISION;
        fee = redeemFee;
    }

    /// @notice Buy tokens with the underlying stablecoin.
    /// @param stableAmount Amount of stablecoin to spend.
    function buy(uint256 stableAmount) external {
        require(stableAmount > 0, "amount zero");

        (uint256 price, uint256 fee) = _buyPrice();
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
            stablecoin.safeTransfer(feeCollector, fee);
        }

        _sendBridgeMessage(ACTION_BUY, msg.sender, netAmount);

        _mint(msg.sender, tokenAmount);
        emit TokensBought(msg.sender, netAmount, tokenAmount);
    }

    /// @notice Redeem tokens for the underlying stablecoin through the bridge.
    /// @param tokenAmount Amount of tokens to redeem.
    function redeem(uint256 tokenAmount) external {
        require(tokenAmount > 0, "amount zero");

        (uint256 price, uint256 fee) = _redeemPrice();
        require(price > 0, "invalid price");

        uint256 stableAmount = (tokenAmount * price) / PRICE_PRECISION;
        require(stableAmount > fee, "amount too small");
        uint256 netAmount = stableAmount - fee;

        _burn(msg.sender, tokenAmount);

        if (fee > 0) {
            stablecoin.safeTransfer(feeCollector, fee);
        }

        _sendBridgeMessage(ACTION_REDEEM, msg.sender, netAmount);
        emit TokensRedeemed(msg.sender, tokenAmount, netAmount);
    }
}

