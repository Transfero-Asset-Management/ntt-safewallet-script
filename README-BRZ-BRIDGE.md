# BRZ NTT Bridge Service

A REST API service for cross-chain BRZ transfers using Wormhole's Native Token Transfer (NTT) framework with Gnosis Safe integration.

## Overview

This service provides programmatic access to bridge BRZ tokens between supported chains while maintaining the security of Gnosis Safe multisig wallets. It converts the original NTT CLI tool into a production-ready API service.

## Features

- REST API for initiating cross-chain BRZ transfers
- Gnosis Safe integration for secure transaction proposals
- Transfer status tracking and monitoring
- Support for all BRZ-enabled chains (Polygon, Arbitrum, Base, Avalanche, BSC)
- Metrics and monitoring endpoints

## API Endpoints

### Bridge Operations
- `POST /api/bridge/transfer` - Initiate a cross-chain transfer
- `GET /api/bridge/transfer/:transferId` - Get transfer status
- `POST /api/bridge/resume/:txHash` - Resume a stuck transfer
- `GET /api/bridge/chains` - Get supported chains

### Status & Monitoring
- `GET /api/status/transfers` - Get recent transfers with filters
- `GET /api/status/safe/:safeAddress` - Get transfers for a specific Safe
- `GET /api/status/metrics` - Get bridge service metrics
- `GET /health` - Health check endpoint

## Setup

1. Install dependencies:
```bash
npm install
```

2. Configure environment:
```bash
cp .env.example .env
# Edit .env with your Safe owner private key
```

3. Run in development:
```bash
npm run dev
```

4. Build for production:
```bash
npm run build
npm start
```

## Production Deployment

### Using PM2:
```bash
npm run build
pm2 start ecosystem.config.js
```

### Environment Variables
- `PORT` - API server port (default: 3003)
- `ETH_PRIVATE_KEY` - Private key of a Safe owner (required for proposing transactions)
- `NODE_ENV` - Environment (development/production)

## Example Usage

### Initiate Transfer
```bash
curl -X POST http://localhost:3003/api/bridge/transfer \
  -H "Content-Type: application/json" \
  -d '{
    "sourceChain": "Arbitrum",
    "destinationChain": "Avalanche",
    "amount": "1000",
    "safeAddress": "0x28f6C070399051e51411eFd44164740f7cD8Ca66"
  }'
```

### Check Transfer Status
```bash
curl http://localhost:3003/api/bridge/transfer/brz-transfer-1234567890-abc123
```

## Architecture

The service:
1. Accepts transfer requests via REST API
2. Uses Wormhole NTT SDK to create bridge transactions
3. Proposes transactions to the Safe multisig
4. Monitors Safe approval and execution
5. Tracks VAA generation and transfer completion

## Security Notes

- The service only proposes transactions; execution requires Safe owner approvals
- Private key is only used for signing Safe proposals, not for direct transfers
- All transfers maintain the same Safe address across chains

## Integration with Auto-Execution Service

This bridge service can be called by the auto-execution service to enable cross-chain arbitrage:

```typescript
// Example integration
const bridgeResponse = await axios.post('http://localhost:3003/api/bridge/transfer', {
  sourceChain: 'Arbitrum',
  destinationChain: 'Avalanche',
  amount: '1000',
  safeAddress: SAFE_ADDRESS
});

// Monitor transfer completion
const status = await axios.get(`http://localhost:3003/api/bridge/transfer/${bridgeResponse.data.transferId}`);
```