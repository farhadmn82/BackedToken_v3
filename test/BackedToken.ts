import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const INITIAL_PRICE = ethers.parseUnits("2", 18);
const PRECISION = ethers.parseUnits("1", 18);

// Helper to deploy contracts for each test
async function deployFixture() {
  const [owner, user, feeCollector] = await ethers.getSigners();

  const Stable = await ethers.getContractFactory("StablecoinMock");
  const stablecoin = await Stable.deploy();
  await stablecoin.waitForDeployment();

  const Oracle = await ethers.getContractFactory("OracleStub");
  const oracle = await Oracle.deploy(INITIAL_PRICE);
  await oracle.waitForDeployment();

  const Bridge = await ethers.getContractFactory("BridgeStub");
  const bridge = await Bridge.deploy();
  await bridge.waitForDeployment();

  const Backed = await ethers.getContractFactory("BackedToken");
  const backedToken = await Backed.deploy(
    stablecoin.target,
    oracle.target,
    feeCollector.address,
    bridge.target
  );
  await backedToken.waitForDeployment();

  // Allow owner to act as operator in tests
  await backedToken.connect(owner).setOperator(owner.address);

  // Mint stablecoins to user and owner for testing
  const supply = ethers.parseUnits("2000", 18);
  await stablecoin.mint(user.address, supply);
  await stablecoin.mint(owner.address, supply);

  return { owner, user, feeCollector, stablecoin, oracle, bridge, backedToken };
}

// Fixture using a bridge that can be configured to fail
async function deployFailingBridgeFixture() {
  const [owner, feeCollector] = await ethers.getSigners();

  const Stable = await ethers.getContractFactory("StablecoinMock");
  const stablecoin = await Stable.deploy();
  await stablecoin.waitForDeployment();

  const Oracle = await ethers.getContractFactory("OracleStub");
  const oracle = await Oracle.deploy(INITIAL_PRICE);
  await oracle.waitForDeployment();

  const Bridge = await ethers.getContractFactory("BridgeStub");
  const bridge = await Bridge.deploy();
  await bridge.waitForDeployment();

  const Backed = await ethers.getContractFactory("BackedToken");
  const backedToken = await Backed.deploy(
    stablecoin.target,
    oracle.target,
    feeCollector.address,
    bridge.target
  );
  await backedToken.waitForDeployment();

  await backedToken.connect(owner).setOperator(owner.address);

  const supply = ethers.parseUnits("2000", 18);
  await stablecoin.mint(owner.address, supply);

  return { owner, stablecoin, bridge, backedToken };
}

describe("BackedToken", function () {
  it("retrieves price from oracle", async function () {
    const { oracle, owner } = await loadFixture(deployFixture);
    const newPrice = ethers.parseUnits("3", 18);
    await oracle.connect(owner).setPrice(newPrice);
    expect(await oracle.getPrice()).to.equal(newPrice);
  });

  it("emits parameter update events", async function () {
    const { owner, backedToken } = await loadFixture(deployFixture);
    const threshold = ethers.parseUnits("10", 18);
    const minBridge = ethers.parseUnits("5", 18);

    await expect(backedToken.connect(owner).setBufferThreshold(threshold))
      .to.emit(backedToken, "BufferThresholdUpdated")
      .withArgs(threshold);

    await expect(backedToken.connect(owner).setMinBridgeAmount(minBridge))
      .to.emit(backedToken, "MinBridgeAmountUpdated")
      .withArgs(minBridge);
  });

  it("applies spreads and fees", async function () {
    const {
      owner,
      user,
      feeCollector,
      stablecoin,
      oracle,
      backedToken,
    } = await loadFixture(deployFixture);

    const buySpread = ethers.parseUnits("0.01", 18); // 1%
    const redeemSpread = ethers.parseUnits("0.02", 18); // 2%
    const buyFee = ethers.parseUnits("1", 18);
    const redeemFee = ethers.parseUnits("2", 18);

    await backedToken
      .connect(owner)
      .setPricingParameters(buySpread, redeemSpread, buyFee, redeemFee);

    // Keep all stablecoins in contract for redemption
    const highThreshold = ethers.parseUnits("1000", 18);
    await backedToken.connect(owner).setBufferThreshold(highThreshold);

    const buyAmount = ethers.parseUnits("100", 18);
    await stablecoin.connect(user).approve(backedToken.target, buyAmount);

    const basePrice = await oracle.getPrice();
    const buyPrice = basePrice + (basePrice * buySpread) / PRECISION;
    const netBuy = buyAmount - buyFee;
    const expectedTokens = (netBuy * PRECISION) / buyPrice;

    await expect(backedToken.connect(user).buy(buyAmount))
      .to.emit(backedToken, "TokensBought")
      .withArgs(user.address, netBuy, expectedTokens);

    expect(await stablecoin.balanceOf(feeCollector.address)).to.equal(buyFee);
    expect(await backedToken.balanceOf(user.address)).to.equal(expectedTokens);

    const redeemPrice = basePrice - (basePrice * redeemSpread) / PRECISION;
    const grossRedeem = (expectedTokens * redeemPrice) / PRECISION;
    const netRedeem = grossRedeem - redeemFee;

    await expect(backedToken.connect(user).redeem(expectedTokens))
      .to.emit(backedToken, "TokensRedeemed")
      .withArgs(user.address, expectedTokens, netRedeem);

    expect(await stablecoin.balanceOf(feeCollector.address)).to.equal(
      buyFee + redeemFee
    );
    expect(await backedToken.balanceOf(user.address)).to.equal(0n);
  });

  it("allows purchasing tokens while keeping buffer", async function () {
    const { user, owner, stablecoin, oracle, bridge, backedToken } = await loadFixture(deployFixture);
    const buyAmount = ethers.parseUnits("100", 18);
    const threshold = ethers.parseUnits("50", 18);

    await backedToken.connect(owner).setBufferThreshold(threshold);
    await stablecoin.connect(user).approve(backedToken.target, buyAmount);

    const price = await oracle.getPrice();
    const expectedTokens = buyAmount * BigInt(1e18) / price;

    const message = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint8", "address", "uint256"],
      [0, user.address, buyAmount]
    );

    const bridged = buyAmount - threshold;

    await expect(backedToken.connect(user).buy(buyAmount))
      .to.emit(bridge, "MessageSent")
      .withArgs(message)
      .and.to.emit(backedToken, "TokensBought")
      .withArgs(user.address, buyAmount, expectedTokens)
      .and.to.not.emit(bridge, "StableSent");

    await expect(backedToken.connect(owner).forwardExcessToBridge())
      .to.emit(bridge, "StableSent")
      .withArgs(stablecoin.target, backedToken.target, bridged);

    expect(await backedToken.balanceOf(user.address)).to.equal(expectedTokens);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(threshold);
    expect(await stablecoin.balanceOf(bridge.target)).to.equal(bridged);

    await expect(bridge.connect(owner).receiveStable(stablecoin.target, bridged))
      .to.emit(bridge, "StableReceived")
      .withArgs(stablecoin.target, owner.address, bridged);
    expect(await stablecoin.balanceOf(bridge.target)).to.equal(0);
  });

  it("only bridges when amount exceeds minimum", async function () {
    const { user, owner, stablecoin, bridge, backedToken } = await loadFixture(deployFixture);
    const threshold = ethers.parseUnits("40", 18);
    const minBridge = ethers.parseUnits("30", 18);
    const firstBuy = ethers.parseUnits("60", 18);
    const secondBuy = ethers.parseUnits("20", 18);

    await backedToken.connect(owner).setBufferThreshold(threshold);
    await backedToken.connect(owner).setMinBridgeAmount(minBridge);

    await stablecoin.connect(user).approve(backedToken.target, firstBuy + secondBuy);

    await expect(backedToken.connect(user).buy(firstBuy))
      .to.not.emit(bridge, "StableSent");
    await expect(backedToken.connect(owner).forwardExcessToBridge()).to.not.emit(
      bridge,
      "StableSent"
    );
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(firstBuy);
    expect(await stablecoin.balanceOf(bridge.target)).to.equal(0);

    const expectedBridge = firstBuy + secondBuy - threshold;
    await expect(backedToken.connect(user).buy(secondBuy))
      .to.not.emit(bridge, "StableSent");
    await expect(backedToken.connect(owner).forwardExcessToBridge())
      .to.emit(bridge, "StableSent")
      .withArgs(stablecoin.target, backedToken.target, expectedBridge);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(threshold);
    expect(await stablecoin.balanceOf(bridge.target)).to.equal(expectedBridge);

    await expect(bridge.connect(owner).receiveStable(stablecoin.target, expectedBridge))
      .to.emit(bridge, "StableReceived")
      .withArgs(stablecoin.target, owner.address, expectedBridge);
    expect(await stablecoin.balanceOf(bridge.target)).to.equal(0);
  });

  it(
    "allows purchasing token less than minBridgeAmount while keeping buffer (Empty Buffer)",
    async function () {
      const { user, owner, stablecoin, oracle, backedToken, bridge } =
        await loadFixture(deployFixture);
      const buyAmount = ethers.parseUnits("80", 18);
      const threshold = ethers.parseUnits("50", 18);
      const minBridge = ethers.parseUnits("50", 18);

      await backedToken.connect(owner).setBufferThreshold(threshold);
      await backedToken.connect(owner).setMinBridgeAmount(minBridge);
      await stablecoin.connect(user).approve(backedToken.target, buyAmount);

      const price = await oracle.getPrice();
      const expectedTokens = (buyAmount * BigInt(1e18)) / price;

      await backedToken.connect(user).buy(buyAmount);
      await expect(backedToken.connect(owner).forwardExcessToBridge()).to.not.emit(
        bridge,
        "StableSent"
      );
      await expect(backedToken.connect(owner).forwardExcessToBridge()).to.not.emit(
        bridge,
        "StableSent"
      );

      const stableLiquidity = await stablecoin.balanceOf(backedToken.target);
      const bridgeBalance = await stablecoin.balanceOf(bridge.target);
      const userBalance = await backedToken.balanceOf(user.address);

      expect(userBalance).to.equal(expectedTokens);
      expect(stableLiquidity).to.equal(buyAmount);
      expect(bridgeBalance).to.equal(0);
    }
  );

  it(
    "allows purchasing token less than minBridgeAmount while keeping buffer (Full Buffer)",
    async function () {
      const { user, owner, stablecoin, oracle, backedToken, bridge } =
        await loadFixture(deployFixture);
      const buyAmount = ethers.parseUnits("40", 18);
      const threshold = ethers.parseUnits("50", 18);
      const minBridge = ethers.parseUnits("50", 18);

      await backedToken.connect(owner).setBufferThreshold(threshold);
      await backedToken.connect(owner).setMinBridgeAmount(minBridge);
      await stablecoin.connect(owner).approve(backedToken.target, threshold);
      await backedToken.connect(owner).depositBuffer(threshold);
      await stablecoin.connect(user).approve(backedToken.target, buyAmount);

      const price = await oracle.getPrice();
      const expectedTokens = (buyAmount * BigInt(1e18)) / price;

      await backedToken.connect(user).buy(buyAmount);

      const stableLiquidity = await stablecoin.balanceOf(backedToken.target);
      const bridgeBalance = await stablecoin.balanceOf(bridge.target);
      const userBalance = await backedToken.balanceOf(user.address);

      expect(userBalance).to.equal(expectedTokens);
      expect(stableLiquidity).to.equal(threshold + buyAmount);
      expect(bridgeBalance).to.equal(0);
    }
  );

  it("allows owner to manage buffer", async function () {
    const { owner, stablecoin, backedToken } = await loadFixture(deployFixture);
    const depositAmount = ethers.parseUnits("20", 18);
    const withdrawAmount = ethers.parseUnits("5", 18);
    await stablecoin.connect(owner).approve(backedToken.target, depositAmount);

    await backedToken.connect(owner).depositBuffer(depositAmount);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(depositAmount);
    await backedToken.connect(owner).withdrawBuffer(withdrawAmount);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(depositAmount - withdrawAmount);
  });

  it("does not leave allowance after failed bridge call", async function () {
    const { owner, stablecoin, bridge, backedToken } = await loadFixture(
      deployFailingBridgeFixture
    );

    const amount = ethers.parseUnits("100", 18);
    await stablecoin.connect(owner).approve(backedToken.target, amount);
    await backedToken.connect(owner).depositBuffer(amount);

    await bridge.setShouldFail(true);

    await expect(
      backedToken.connect(owner).forwardExcessToBridge()
    ).to.be.revertedWith("bridge failed");

    expect(await stablecoin.allowance(backedToken.target, bridge.target)).to.equal(0n);
  });

  it("processes queued redemptions before forwarding excess", async function () {
    const { owner, user, stablecoin, backedToken, bridge, oracle } = await loadFixture(
      deployFixture
    );

    const threshold = ethers.parseUnits("30", 18);
    const highMinBridge = ethers.parseUnits("100", 18);
    const minBridge = ethers.parseUnits("5", 18);
    const initialBuy = ethers.parseUnits("60", 18);

    await backedToken.connect(owner).setBufferThreshold(threshold);
    await backedToken.connect(owner).setMinBridgeAmount(highMinBridge);

    await stablecoin.connect(owner).approve(backedToken.target, initialBuy);
    await backedToken.connect(owner).buy(initialBuy);
    await backedToken.connect(owner).forwardExcessToBridge();

    const price = await oracle.getPrice();
    const tokens = (initialBuy * BigInt(1e18)) / price;
    await backedToken.connect(owner).transfer(user.address, tokens);

    await backedToken.connect(owner).withdrawBuffer(initialBuy);
    await backedToken.connect(owner).setMinBridgeAmount(minBridge);

    const expectedPayout = (tokens * price) / BigInt(1e18);
    await backedToken.connect(user).redeem(tokens);
    await backedToken
      .connect(owner)
      .processRedemptions(user.address, expectedPayout);
    expect(await backedToken.redemptionQueueLength()).to.equal(1n);

    const buyAmount = ethers.parseUnits("100", 18);
    await stablecoin.connect(user).approve(backedToken.target, buyAmount);

    const expectedBridge = ethers.parseUnits("10", 18);
    await expect(backedToken.connect(user).buy(buyAmount)).to.not.emit(
      bridge,
      "StableSent"
    );
    await backedToken
      .connect(owner)
      .processRedemptions(ethers.ZeroAddress, 0);
    await expect(backedToken.connect(owner).forwardExcessToBridge())
      .to.emit(bridge, "StableSent")
      .withArgs(stablecoin.target, backedToken.target, expectedBridge);

    expect(await backedToken.redemptionQueueLength()).to.equal(0n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(threshold);
    expect(await stablecoin.balanceOf(bridge.target)).to.equal(expectedBridge);
    expect(await stablecoin.balanceOf(user.address)).to.equal(
      ethers.parseUnits("2000", 18) - buyAmount + ethers.parseUnits("60", 18)
    );

    await expect(bridge.connect(owner).receiveStable(stablecoin.target, expectedBridge))
      .to.emit(bridge, "StableReceived")
      .withArgs(stablecoin.target, owner.address, expectedBridge);
    expect(await stablecoin.balanceOf(bridge.target)).to.equal(0);
  });

  it("queues and processes redemption when liquidity is added", async function () {
    const { user, owner, stablecoin, oracle, backedToken, bridge } = await loadFixture(deployFixture);
    const buyAmount = ethers.parseUnits("50", 18);
    const redeemTokens = ethers.parseUnits("25", 18);

    await stablecoin.connect(user).approve(backedToken.target, buyAmount);
    await backedToken.connect(user).buy(buyAmount);
    await backedToken.connect(owner).forwardExcessToBridge();

    const price = await oracle.getPrice();
    const expectedPayout = (redeemTokens * price) / BigInt(1e18);

    const message = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint8", "address", "uint256"],
      [1, user.address, expectedPayout]
    );

    await expect(backedToken.connect(user).redeem(redeemTokens))
      .to.emit(bridge, "MessageSent")
      .withArgs(message)
      .and.to.emit(backedToken, "TokensRedeemed")
      .withArgs(user.address, redeemTokens, expectedPayout);

    await backedToken
      .connect(owner)
      .processRedemptions(user.address, expectedPayout);
    expect(await backedToken.redemptionQueueLength()).to.equal(1n);

    await stablecoin.connect(owner).approve(backedToken.target, expectedPayout);
    await backedToken.connect(owner).depositBuffer(expectedPayout);
    await backedToken
      .connect(owner)
      .processRedemptions(ethers.ZeroAddress, 0);

    expect(await backedToken.redemptionQueueLength()).to.equal(0n);
    expect(await stablecoin.balanceOf(user.address)).to.equal(
      ethers.parseUnits("2000", 18) - buyAmount + expectedPayout
    );
  });

  it("does not pay smaller queued request when earlier exceeds liquidity", async function () {
    const { owner, user, stablecoin, backedToken } = await loadFixture(deployFixture);

    const buyAmount = ethers.parseUnits("200", 18);
    await stablecoin.connect(owner).approve(backedToken.target, buyAmount);
    await backedToken.connect(owner).buy(buyAmount);
    await backedToken.connect(owner).forwardExcessToBridge();

    const bigTokens = ethers.parseUnits("50", 18);
    await backedToken.connect(owner).transfer(user.address, bigTokens);

    const bigPayout = (bigTokens * INITIAL_PRICE) / PRECISION;
    await backedToken.connect(user).redeem(bigTokens);
    await backedToken
      .connect(owner)
      .processRedemptions(user.address, bigPayout);

    const smallTokens = ethers.parseUnits("20", 18);
    const smallPayout = (smallTokens * INITIAL_PRICE) / PRECISION;
    await backedToken.connect(owner).redeem(smallTokens);
    await backedToken
      .connect(owner)
      .processRedemptions(owner.address, smallPayout);

    expect(await backedToken.redemptionQueueLength()).to.equal(2n);

    const deposit1 = ethers.parseUnits("60", 18);
    await stablecoin.connect(owner).approve(backedToken.target, deposit1);
    await backedToken.connect(owner).depositBuffer(deposit1);
    await backedToken
      .connect(owner)
      .processRedemptions(ethers.ZeroAddress, 0);
    // Liquidity insufficient for first request
    expect(await backedToken.redemptionQueueLength()).to.equal(2n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(deposit1);

    const deposit2 = ethers.parseUnits("40", 18);
    await stablecoin.connect(owner).approve(backedToken.target, deposit2);
    await backedToken.connect(owner).depositBuffer(deposit2);
    await backedToken
      .connect(owner)
      .processRedemptions(ethers.ZeroAddress, 0);
    // First request paid, second still queued
    expect(await backedToken.redemptionQueueLength()).to.equal(1n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(0);

    const deposit3 = ethers.parseUnits("40", 18);
    await stablecoin.connect(owner).approve(backedToken.target, deposit3);
    await backedToken.connect(owner).depositBuffer(deposit3);
    await backedToken
      .connect(owner)
      .processRedemptions(ethers.ZeroAddress, 0);
    // Second request now paid
    expect(await backedToken.redemptionQueueLength()).to.equal(0n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(0);
  });

  it("queues new small redemption when earlier oversized request exists", async function () {
    const { owner, user, stablecoin, backedToken } = await loadFixture(deployFixture);

    const buyAmount = ethers.parseUnits("200", 18);
    await stablecoin.connect(owner).approve(backedToken.target, buyAmount);
    await backedToken.connect(owner).buy(buyAmount);
    await backedToken.connect(owner).forwardExcessToBridge();

    const bigTokens = ethers.parseUnits("50", 18);
    await backedToken.connect(owner).transfer(user.address, bigTokens);
    const bigPayout = (bigTokens * INITIAL_PRICE) / PRECISION;
    await backedToken.connect(user).redeem(bigTokens);
    await backedToken
      .connect(owner)
      .processRedemptions(user.address, bigPayout);
    expect(await backedToken.redemptionQueueLength()).to.equal(1n);

    const deposit = ethers.parseUnits("60", 18);
    await stablecoin.connect(owner).approve(backedToken.target, deposit);
    await backedToken.connect(owner).depositBuffer(deposit);
    await backedToken
      .connect(owner)
      .processRedemptions(ethers.ZeroAddress, 0);

    // Still waiting for big request
    expect(await backedToken.redemptionQueueLength()).to.equal(1n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(deposit);

    const smallTokens = ethers.parseUnits("20", 18);
    const smallPayout = (smallTokens * INITIAL_PRICE) / PRECISION;
    await backedToken.connect(owner).redeem(smallTokens);
    await backedToken
      .connect(owner)
      .processRedemptions(owner.address, smallPayout);

    // Small request queued behind big one
    expect(await backedToken.redemptionQueueLength()).to.equal(2n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(deposit);
  });

  it("processes redemptions in batches", async function () {
    const { owner, stablecoin, backedToken, oracle } = await loadFixture(deployFixture);

    const buyAmount = ethers.parseUnits("400", 18);
    await stablecoin.connect(owner).approve(backedToken.target, buyAmount);
    await backedToken.connect(owner).buy(buyAmount);
    await backedToken.connect(owner).forwardExcessToBridge();

    const price = await oracle.getPrice();
    const redeemTokens = ethers.parseUnits("10", 18);
    const payout = (redeemTokens * price) / BigInt(1e18);

    for (let i = 0; i < 7; i++) {
      await backedToken.connect(owner).redeem(redeemTokens);
      await backedToken
        .connect(owner)
        .processRedemptions(owner.address, payout);
    }

    expect(await backedToken.redemptionQueueLength()).to.equal(7n);

    const depositAll = payout * 7n;
    await stablecoin.connect(owner).approve(backedToken.target, depositAll);
    await backedToken.connect(owner).depositBuffer(depositAll);
    await backedToken
      .connect(owner)
      .processRedemptions(ethers.ZeroAddress, 0);

    // Only five requests processed in first batch
    expect(await backedToken.redemptionQueueLength()).to.equal(2n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(payout * 2n);

    await stablecoin.connect(owner).approve(backedToken.target, payout);
    await backedToken.connect(owner).depositBuffer(payout);
    await backedToken
      .connect(owner)
      .processRedemptions(ethers.ZeroAddress, 0);

    expect(await backedToken.redemptionQueueLength()).to.equal(0n);
  });
});
