import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

// Helper to deploy contracts for each test
async function deployFixture() {
  const [owner, user] = await ethers.getSigners();

  const Stable = await ethers.getContractFactory("StablecoinMock");
  const stablecoin = await Stable.deploy();
  await stablecoin.waitForDeployment();

  const Oracle = await ethers.getContractFactory("OracleStub");
  const initialPrice = ethers.parseUnits("1", 18);
  const oracle = await Oracle.deploy(initialPrice);
  await oracle.waitForDeployment();

  const Bridge = await ethers.getContractFactory("BridgeStub");
  const bridge = await Bridge.deploy();
  await bridge.waitForDeployment();

  const Backed = await ethers.getContractFactory("BackedToken");
  const backedToken = await Backed.deploy(stablecoin.target, oracle.target, bridge.target);
  await backedToken.waitForDeployment();

  // Mint stablecoins to user for testing
  const supply = ethers.parseUnits("1000", 18);
  await stablecoin.mint(user.address, supply);

  return { owner, user, stablecoin, oracle, bridge, backedToken };
}

describe("BackedToken", function () {
  it("retrieves price from oracle", async function () {
    const { oracle, owner } = await loadFixture(deployFixture);
    const newPrice = ethers.parseUnits("2", 18);
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

    await expect(backedToken.connect(user).buy(buyAmount))
      .to.emit(bridge, "StableSent")
      .withArgs(stablecoin.target, backedToken.target, buyAmount - threshold);

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

  it("allows owner to manage buffer", async function () {
    const { owner, stablecoin, backedToken } = await loadFixture(deployFixture);
    const depositAmount = ethers.parseUnits("20", 18);
    const withdrawAmount = ethers.parseUnits("5", 18);

    await stablecoin.mint(owner.address, depositAmount);
    await stablecoin.connect(owner).approve(backedToken.target, depositAmount);

    await backedToken.connect(owner).depositBuffer(depositAmount);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(depositAmount);

    await backedToken.connect(owner).withdrawBuffer(withdrawAmount);
    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(depositAmount - withdrawAmount);
  });

  it("uses buffer on redeem before bridging", async function () {
    const { user, owner, stablecoin, oracle, bridge, backedToken } = await loadFixture(deployFixture);
    const buyAmount = ethers.parseUnits("50", 18);
    const bufferDeposit = ethers.parseUnits("20", 18);
    const redeemTokens = ethers.parseUnits("30", 18);

    // Buy tokens (all funds go through bridge since threshold is 0)
    await stablecoin.connect(user).approve(backedToken.target, buyAmount);
    await backedToken.connect(user).buy(buyAmount);

    // Owner deposits liquidity for redemptions
    await stablecoin.mint(owner.address, bufferDeposit);
    await stablecoin.connect(owner).approve(backedToken.target, bufferDeposit);
    await backedToken.connect(owner).depositBuffer(bufferDeposit);

    const price = await oracle.getPrice();
    const expectedBridge = (redeemTokens * price) / BigInt(1e18) - bufferDeposit;
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode([
      "address",
      "uint256",
    ], [user.address, expectedBridge]);

    await expect(backedToken.connect(user).redeem(redeemTokens))
      .to.emit(bridge, "MessageSent")
      .withArgs(encoded);

    expect(await stablecoin.balanceOf(backedToken.target)).to.equal(0n);
    expect(await stablecoin.balanceOf(user.address)).to.equal(
      ethers.parseUnits("1000", 18) - buyAmount + bufferDeposit
    );
  });
});
