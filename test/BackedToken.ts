import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const INITIAL_PRICE = ethers.parseUnits("2", 18);

// Helper to deploy contracts for each test
async function deployFixture() {
  const [owner, user] = await ethers.getSigners();

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
  const backedToken = await Backed.deploy(stablecoin.target, oracle.target, bridge.target);
  await backedToken.waitForDeployment();

  // Mint stablecoins to user and owner for testing
  const supply = ethers.parseUnits("2000", 18);
  await stablecoin.mint(user.address, supply);
  await stablecoin.mint(owner.address, supply);

  return { owner, user, stablecoin, oracle, bridge, backedToken };
}

describe("BackedToken", function () {
  it("retrieves price from oracle", async function () {
    const { oracle, owner } = await loadFixture(deployFixture);
    const newPrice = ethers.parseUnits("3", 18);
    await oracle.connect(owner).setPrice(newPrice);
    expect(await oracle.getPrice()).to.equal(newPrice);
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

    await expect(backedToken.connect(user).buy(buyAmount))
      .to.emit(bridge, "StableSent")
      .withArgs(stablecoin.target, backedToken.target, buyAmount - threshold)
      .and.to.emit(bridge, "MessageSent")
      .withArgs(message);

    expect(await backedToken.balanceOf(user.address)).to.equal(expectedTokens);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(threshold);
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

    await expect(backedToken.connect(user).buy(firstBuy)).to.not.emit(bridge, "StableSent");
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(firstBuy);

    const expectedBridge = firstBuy + secondBuy - threshold;
    await expect(backedToken.connect(user).buy(secondBuy))
      .to.emit(bridge, "StableSent")
      .withArgs(stablecoin.target, backedToken.target, expectedBridge);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(threshold);
  });

  it(
    "allows purchasing token less than minBridgeAmount while keeping buffer (Empty Buffer)",
    async function () {
      const { user, owner, stablecoin, oracle, backedToken } = await loadFixture(
        deployFixture
      );
      const buyAmount = ethers.parseUnits("80", 18);
      const threshold = ethers.parseUnits("50", 18);
      const minBridge = ethers.parseUnits("50", 18);

      await backedToken.connect(owner).setBufferThreshold(threshold);
      await backedToken.connect(owner).setMinBridgeAmount(minBridge);
      await stablecoin.connect(user).approve(backedToken.target, buyAmount);

      const price = await oracle.getPrice();
      const expectedTokens = (buyAmount * BigInt(1e18)) / price;

      await backedToken.connect(user).buy(buyAmount);

      const stableLiquidity = await stablecoin.balanceOf(backedToken.target);
      const userBalance = await backedToken.balanceOf(user.address);

      expect(userBalance).to.equal(expectedTokens);
      expect(stableLiquidity).to.equal(buyAmount);
    }
  );

  it(
    "allows purchasing token less than minBridgeAmount while keeping buffer (Full Buffer)",
    async function () {
      const { user, owner, stablecoin, oracle, backedToken } = await loadFixture(
        deployFixture
      );
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
      const userBalance = await backedToken.balanceOf(user.address);

      expect(userBalance).to.equal(expectedTokens);
      expect(stableLiquidity).to.equal(threshold + buyAmount);
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

    const price = await oracle.getPrice();
    const tokens = (initialBuy * BigInt(1e18)) / price;
    await backedToken.connect(owner).transfer(user.address, tokens);

    await backedToken.connect(owner).withdrawBuffer(initialBuy);
    await backedToken.connect(owner).setMinBridgeAmount(minBridge);

    await backedToken.connect(user).redeem(tokens);
    expect(await backedToken.redemptionQueueLength()).to.equal(1n);

    const buyAmount = ethers.parseUnits("100", 18);
    await stablecoin.connect(user).approve(backedToken.target, buyAmount);

    await expect(backedToken.connect(user).buy(buyAmount))
      .to.emit(bridge, "StableSent")
      .withArgs(stablecoin.target, backedToken.target, ethers.parseUnits("10", 18));

    expect(await backedToken.redemptionQueueLength()).to.equal(0n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(threshold);
    expect(await stablecoin.balanceOf(user.address)).to.equal(
      ethers.parseUnits("2000", 18) - buyAmount + ethers.parseUnits("60", 18)
    );
  });

  it("queues and processes redemption when liquidity is added", async function () {
    const { user, owner, stablecoin, oracle, backedToken, bridge } = await loadFixture(deployFixture);
    const buyAmount = ethers.parseUnits("50", 18);
    const redeemTokens = ethers.parseUnits("25", 18);

    await stablecoin.connect(user).approve(backedToken.target, buyAmount);
    await backedToken.connect(user).buy(buyAmount);

    const price = await oracle.getPrice();
    const expectedPayout = (redeemTokens * price) / BigInt(1e18);

    const message = ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint8", "address", "uint256"],
      [1, user.address, expectedPayout]
    );

    await expect(backedToken.connect(user).redeem(redeemTokens))
      .to.emit(bridge, "MessageSent")
      .withArgs(message);

    expect(await backedToken.redemptionQueueLength()).to.equal(1n);

    await stablecoin.connect(owner).approve(backedToken.target, expectedPayout);
    await backedToken.connect(owner).depositBuffer(expectedPayout);

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

    const bigTokens = ethers.parseUnits("50", 18);
    await backedToken.connect(owner).transfer(user.address, bigTokens);
    await backedToken.connect(user).redeem(bigTokens);

    const smallTokens = ethers.parseUnits("20", 18);
    await backedToken.connect(owner).redeem(smallTokens);

    expect(await backedToken.redemptionQueueLength()).to.equal(2n);

    const deposit1 = ethers.parseUnits("60", 18);
    await stablecoin.connect(owner).approve(backedToken.target, deposit1);
    await backedToken.connect(owner).depositBuffer(deposit1);
    // Liquidity insufficient for first request
    expect(await backedToken.redemptionQueueLength()).to.equal(2n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(deposit1);

    const deposit2 = ethers.parseUnits("40", 18);
    await stablecoin.connect(owner).approve(backedToken.target, deposit2);
    await backedToken.connect(owner).depositBuffer(deposit2);
    // First request paid, second still queued
    expect(await backedToken.redemptionQueueLength()).to.equal(1n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(0);

    const deposit3 = ethers.parseUnits("40", 18);
    await stablecoin.connect(owner).approve(backedToken.target, deposit3);
    await backedToken.connect(owner).depositBuffer(deposit3);
    // Second request now paid
    expect(await backedToken.redemptionQueueLength()).to.equal(0n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(0);
  });

  it("queues new small redemption when earlier oversized request exists", async function () {
    const { owner, user, stablecoin, backedToken } = await loadFixture(deployFixture);

    const buyAmount = ethers.parseUnits("200", 18);
    await stablecoin.connect(owner).approve(backedToken.target, buyAmount);
    await backedToken.connect(owner).buy(buyAmount);

    const bigTokens = ethers.parseUnits("50", 18);
    await backedToken.connect(owner).transfer(user.address, bigTokens);
    await backedToken.connect(user).redeem(bigTokens);
    expect(await backedToken.redemptionQueueLength()).to.equal(1n);

    const deposit = ethers.parseUnits("60", 18);
    await stablecoin.connect(owner).approve(backedToken.target, deposit);
    await backedToken.connect(owner).depositBuffer(deposit);
    // Still waiting for big request
    expect(await backedToken.redemptionQueueLength()).to.equal(1n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(deposit);

    const smallTokens = ethers.parseUnits("20", 18);
    await backedToken.connect(owner).redeem(smallTokens);
    // Small request queued behind big one
    expect(await backedToken.redemptionQueueLength()).to.equal(2n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(deposit);
  });

  it("processes redemptions in batches", async function () {
    const { owner, stablecoin, backedToken, oracle } = await loadFixture(deployFixture);

    const buyAmount = ethers.parseUnits("400", 18);
    await stablecoin.connect(owner).approve(backedToken.target, buyAmount);
    await backedToken.connect(owner).buy(buyAmount);

    const price = await oracle.getPrice();
    const redeemTokens = ethers.parseUnits("10", 18);
    const payout = (redeemTokens * price) / BigInt(1e18);

    for (let i = 0; i < 7; i++) {
      await backedToken.connect(owner).redeem(redeemTokens);
    }

    expect(await backedToken.redemptionQueueLength()).to.equal(7n);

    const depositAll = payout * 7n;
    await stablecoin.connect(owner).approve(backedToken.target, depositAll);
    await backedToken.connect(owner).depositBuffer(depositAll);

    // Only five requests processed in first batch
    expect(await backedToken.redemptionQueueLength()).to.equal(2n);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(payout * 2n);

    await stablecoin.connect(owner).approve(backedToken.target, payout);
    await backedToken.connect(owner).depositBuffer(payout);

    expect(await backedToken.redemptionQueueLength()).to.equal(0n);
  });
});
