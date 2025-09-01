import { ethers } from "hardhat";
import "dotenv/config";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying with: ${deployer.address}`);

  const stablecoin = process.env.STABLECOIN_ADDRESS;
  const feeCollector = process.env.FEE_COLLECTOR_ADDRESS;
  const bridge = process.env.BRIDGE_ADDRESS;

  if (!stablecoin || !feeCollector || !bridge) {
    throw new Error(
      "Missing env vars: STABLECOIN_ADDRESS, FEE_COLLECTOR_ADDRESS, BRIDGE_ADDRESS"
    );
  }

  let oracleAddr = process.env.ORACLE_ADDRESS;
  if (!oracleAddr) {
    const feed =
      process.env.CHAINLINK_FEED_ADDRESS ||
      "0x2514895c72F50d8Bd4B4F9b1117fCD4c2b8f8A70"; // BNB/USD BSC testnet
    const Oracle = await ethers.getContractFactory("ChainlinkOracle");
    const oracle = await Oracle.deploy(feed);
    await oracle.waitForDeployment();
    oracleAddr = await oracle.getAddress();
    console.log(`ChainlinkOracle deployed to: ${oracleAddr} (feed: ${feed})`);
  }

  const Backed = await ethers.getContractFactory("BackedToken");
  const backed = await Backed.deploy(stablecoin, oracleAddr, feeCollector, bridge);
  await backed.waitForDeployment();
  const addr = await backed.getAddress();
  console.log(`BackedToken deployed to: ${addr}`);

  if (process.env.NEW_ORACLE_ADDRESS) {
    const tx = await backed.setOracle(process.env.NEW_ORACLE_ADDRESS);
    await tx.wait();
    console.log(`Oracle set to: ${process.env.NEW_ORACLE_ADDRESS}`);
  }

  if (process.env.NEW_BRIDGE_ADDRESS) {
    const tx = await backed.setBridge(process.env.NEW_BRIDGE_ADDRESS);
    await tx.wait();
    console.log(`Bridge set to: ${process.env.NEW_BRIDGE_ADDRESS}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
