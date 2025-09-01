# BackedToken_v3

## Deployment

Create a `.env` file by copying `.env.example` and filling in the required addresses:

```
cp .env.example .env
```

Then edit `.env` to provide:

```
STABLECOIN_ADDRESS=0x...
FEE_COLLECTOR_ADDRESS=0x...
BRIDGE_ADDRESS=0x...

# Optional overrides
# ORACLE_ADDRESS=0x...
# CHAINLINK_FEED_ADDRESS=0x...
# NEW_ORACLE_ADDRESS=0x...
# NEW_BRIDGE_ADDRESS=0x...
```

Run the deployment script with Hardhat:

```
npx hardhat run scripts/deploy.ts --network <network>
```
