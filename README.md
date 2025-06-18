# NTT Safe Multisig Integration with Wormhole TS-SDK

## Overview

This project demonstrates the use of the Wormhole TS-SDK to facilitate secure token transfers between different blockchain networks using Safe multisig wallets, after performing a deployment of the [Native Token Transfer](https://docs.wormhole.com/wormhole/native-token-transfers/overview) framework. The script proposes transactions to Safe multisig wallets instead of executing them directly, providing enhanced security for cross-chain transfers.

## Prerequisites

Ensure you have the following installed on your system:

- Node.js & TypeScript
- npm or yarn
- A Safe multisig wallet deployed on the source chain
- Access to Safe API services for the networks you're using 

## Setup

1. **Clone the Repository:**

   ```bash
   git clone https://github.com/wormhole-foundation/demo-ntt-ts-sdk.git
   cd /demo-ntt-ts-sdk
   ```

2. **Install Dependencies:**

   ```bash
   npm install
   ```

   or

   ```bash
   yarn 
   ```

3. **Update Configuration:**

   - **Reference `deployment.json`:**
     The `example-deployment.json` file contains an example deployment file for your blockchain networks. You should have a similar file in your project after going through the an NTT [deployment](https://docs.wormhole.com/wormhole/native-token-transfers/deployment/installation)

   - **Update `const.ts`:**
     Update the `NTT_TOKENS` object in the `src/utils/const.ts` file with your token, manager, and transceiver details from the `deployment.json` file:

     ```typescript
     export const NTT_TOKENS: NttContracts = {
       Polygon: {
         token: "NTTPolygonTokenAddress",
         manager: "NTTPolygonManagerAddress",
         transceiver: {
           wormhole: "NTTPolygonTransceiverAddress",
         },
       },
       Base: {
         token: "NTTBaseTokenAddress",
         manager: "NTTBaseManagerAddress",
         transceiver: { wormhole: "NTTBaseTransceiverAddress" },
       },
       // Add other chains as needed (Avalanche, Arbitrum, Bsc, Unichain)
     };
     ```

     Also update the `CHAIN_CONFIGS` object with your RPC endpoints and chain IDs:

     ```typescript
     export const CHAIN_CONFIGS: ChainConfigs = {
       Base: {
         rpc: "https://your-base-rpc-endpoint",
         chainId: 8453,
       },
       Polygon: {
         rpc: "https://your-polygon-rpc-endpoint", 
         chainId: 137,
       },
       // Add other chains as needed
     };
     ```

   - **Set Environment Variables:**
     Create a `.env` file in the project root and set your private key:

     ```bash
     ETH_PRIVATE_KEY=0xYourEthereumPrivateKey
     ```

     **Note:** This private key should correspond to one of the owners of your Safe multisig wallet.

   - **Custom RPC Configuration (Optional):**
     To override the default RPC endpoints used by the SDK, provide a configuration object when initializing the Wormhole instance:

     ```typescript
     const wh = new Wormhole("Testnet", [solana.Platform, evm.Platform], {
       "chains": {
         "BaseSepolia": {
           "rpc": "https://your-base-sepolia-rpc.example.com"
         },
         "Solana": {
           "rpc": "https://your-solana-rpc.example.com"
         }
       }
     });
     ```

## Running the Script

The script now accepts command line arguments for flexible cross-chain transfers with Safe multisig integration:

```bash
ts-node src/index.ts <srcChain> <dstChain> <srcSafeAddress> <dstAddress> <amount>
```

### Parameters:
- `srcChain`: Source blockchain name (e.g., "Polygon", "Base", "Avalanche")
- `dstChain`: Destination blockchain name 
- `srcSafeAddress`: Address of the Safe multisig wallet on the source chain
- `dstAddress`: Destination address to receive tokens
- `amount`: Amount of tokens to transfer (as a decimal string)

### Example:
```bash
ts-node src/index.ts Polygon Base 0x123...abc 0x456...def 0.1
```

This command will:
1. Initiate a transfer of 0.1 tokens from Polygon to Base
2. Propose all necessary transactions to the Safe multisig at `0x123...abc`
3. Wait for Safe owners to approve and execute the transactions
4. Monitor the transfer status and attempt VAA retrieval once executed

### Available Chains:
The script will display available configured chains if you provide invalid arguments or run without parameters.

## Safe Multisig Integration

### How It Works

The script integrates with Safe multisig wallets to provide secure cross-chain transfers:

1. **Transaction Proposal**: Instead of executing transactions directly, the script proposes them to your Safe multisig wallet
2. **Multiple Transactions**: NTT transfers may require multiple transactions - the script handles all of them automatically
3. **Safe API Integration**: Uses Safe's API to check for existing transactions and monitor approval status
4. **Execution Monitoring**: Waits for Safe owners to approve and execute transactions before proceeding

### Safe Setup Requirements

- Deploy a Safe multisig wallet on your source chain
- Ensure the private key in your `.env` corresponds to one of the Safe owners
- The Safe must have sufficient token balance for the transfer
- Safe API services must be available for your target networks

### Supported Networks

The script supports Safe integration on networks where Safe API services are available, including:
- Ethereum Mainnet
- Polygon
- Base
- Arbitrum
- Avalanche
- BSC
- And other Safe-supported networks


## Troubleshooting

### Safe Transaction Monitoring

The script monitors Safe transactions and provides real-time updates:
- **Pending**: Transaction is proposed and waiting for approvals
- **Confirmations**: Shows current vs required confirmations from Safe owners
- **Execution**: Transaction is executed and waiting for network confirmation
- **Completion**: Transaction is confirmed on the blockchain

### Common Issues

1. **"Transaction already exists"**: The script detects duplicate transactions and will reference the existing Safe transaction hash
2. **Insufficient Approvals**: Ensure enough Safe owners approve the transaction for execution
3. **Network Delays**: Cross-chain transfers require blockchain finality, which can take 10-15 minutes on some networks
4. **RPC Issues**: Verify your RPC endpoints in `CHAIN_CONFIGS` are working correctly

### Finality Delays

Cross-chain transfers require time for blockchain finality:
- **Ethereum/L2s**: 10-15 minutes for finality
- **VAA Generation**: Wormhole guardians need finalized transactions to create VAAs
- **Monitoring**: The script will wait and retry until transactions are finalized

### Resuming Failed Transfers

If a transfer gets stuck after Safe execution, you can use the `resume.ts` script:

1. Open `src/resume.ts`
2. Replace `YOUR_TRANSACTION_ID_HERE` with the executed transaction hash
3. Run the script:
   ```bash
   ts-node src/resume.ts
   ```

The script will attempt to fetch the VAA and complete the redemption on the destination chain.
