# GS013 Error Solution

## Problem
The auto-execution service was getting GS013 errors ("Safe transaction already executed") when trying to execute bridge transactions through Wormhole NTT.

## Root Cause
The Safe smart contract maintains a record of executed transactions based on their exact parameters. When the auto-execution service tried to bridge the same amount multiple times (even with different nonces), it created transactions with identical data, which the Safe rejected.

### Specific Issue
- Auto-execution calculated a deficit (e.g., 6.77 BRZ) and added a small buffer (1%)
- This resulted in the same amount (6.864169878492211 BRZ) being attempted multiple times
- Even though the nonce was different, the Safe contract recognized this as a duplicate transaction

## Why GS013 Occurs
The Safe contract generates a transaction hash based on:
- Transaction data (to, value, data)
- Nonce
- Other Safe parameters

However, it also maintains internal state about executed operations. If the exact same operation (same MultiSend data with same amounts) was executed before, it can reject it with GS013, even with a different nonce.

## Solution Implemented

### 1. Increased Randomization in Amount Calculation
Updated `auto-rebalancing.service.ts` to use:
```typescript
const baseBuffer = 1.01; // 1% for fees
const timestamp = Date.now();
const randomBuffer = 0.002 + (Math.random() * 0.015) + ((timestamp % 1000) / 100000);
const amountToTransfer = deficit * (baseBuffer + randomBuffer);
```

This ensures:
- Base 1% buffer for bridge fees
- 0.2% to 1.7% random variation
- Timestamp-based micro-variation
- Total buffer range: 1.2% to 2.7%

### 2. Duplicate Detection
Added logic to check recent rebalancing history and avoid attempting similar transfers within 15 minutes.

### 3. Better Error Handling
- Detect when a transaction already exists in the Safe service
- Return success if the transaction was already executed
- Properly handle the GS013 error and provide clear feedback

## Testing
To test Wormhole bridges directly:
```bash
node test-fresh-bridge.js
```

To diagnose Safe nonce issues:
```bash
node diagnose-nonce.js
```

To check for duplicate transactions:
```bash
node manage-pending-tx.js
```

## Key Learnings
1. The Safe contract is very strict about duplicate transactions
2. Even with different nonces, identical transaction data can be rejected
3. Always use unique amounts for bridge operations to avoid conflicts
4. Clear pending transactions that fail with GS013 to unblock the Safe

## Prevention
- Always use unique amounts (with timestamp + random components)
- Check for pending transactions before creating new ones
- Monitor the Safe's nonce state
- Clear failed transactions promptly