# How to Start NTT Service with Correct Private Key

## Problem
The NTT service needs a private key from one of the Safe owners to propose and execute transactions.

## Safe Owners
1. `0x567a3998c95a3512554002863C820cA04F79FC9f`
2. `0x33571C55573E1ed40D51F3B0d1307A4F96c8d300`
3. `0xfD213155B94BF26Bd0853b2C22CB99A2018Ce23C`

## Solution

### Option 1: Set environment variable and start service
```bash
# Replace YOUR_PRIVATE_KEY with the actual private key of one of the owners
export SAFE_MODULE_OWNER_PRIVATE_KEY="YOUR_PRIVATE_KEY"
npm run dev
```

### Option 2: Use .env file
Create a `.env` file in `/Users/patricio/Documents/Projects/arbitrage/ntt-safewallet-script`:
```
SAFE_MODULE_OWNER_PRIVATE_KEY=YOUR_PRIVATE_KEY
```
Then run:
```bash
npm run dev
```

### Option 3: Pass directly when starting
```bash
SAFE_MODULE_OWNER_PRIVATE_KEY="YOUR_PRIVATE_KEY" npm run dev
```

## Verify It's Working
After starting with the correct key, you should see in the logs:
```
[Bridge] Initialized with signer address: 0x... (one of the owner addresses)
```

## Then Run the Bridge
Once the service is running with the correct key:
```bash
node simple-bridge-5brz.js
```

This will execute a 5 BRZ bridge from Avalanche to Arbitrum.