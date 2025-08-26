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

  it("allows purchasing tokens", async function () {
    const { user, stablecoin, oracle, bridge, backedToken } = await loadFixture(deployFixture);
    const buyAmount = ethers.parseUnits("100", 18);

    await stablecoin.connect(user).approve(backedToken.target, buyAmount);

    const price = await oracle.getPrice();
    const expectedTokens = buyAmount * BigInt(1e18) / price;

    await expect(backedToken.connect(user).buy(buyAmount))
      .to.emit(bridge, "StableSent")
      .withArgs(stablecoin.target, backedToken.target, buyAmount);

    expect(await backedToken.balanceOf(user.address)).to.equal(expectedTokens);
    expect(await stablecoin.balanceOf(bridge.target)).to.equal(buyAmount);

    // simulate the stablecoin being received on the other chain
    await bridge.receiveStable(stablecoin.target, buyAmount);
  });

  it("allows redeeming tokens", async function () {
    const { user, stablecoin, oracle, bridge, backedToken } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits("50", 18);

    await stablecoin.connect(user).approve(backedToken.target, amount);
    await backedToken.connect(user).buy(amount);

    const price = await oracle.getPrice();
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode([
      "address",
      "uint256",
    ], [user.address, (amount * price) / BigInt(1e18)]);

    await expect(backedToken.connect(user).redeem(amount))
      .to.emit(bridge, "MessageSent")
      .withArgs(encoded);

    expect(await backedToken.balanceOf(user.address)).to.equal(0n);

    // simulate stablecoin release through the bridge
    await bridge.receiveStable(stablecoin.target, amount);
  });
});
