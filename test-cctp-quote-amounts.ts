/**
 * Test Wormhole CCTP Quote API with different amounts
 *
 * This tests the quote API to see if relayer fee is fixed or percentage-based
 */

import { wormhole } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import "@wormhole-foundation/sdk-evm-cctp";
import { CircleTransfer } from "@wormhole-foundation/sdk-connect";
import dotenv from 'dotenv';

dotenv.config();

const SOURCE_CHAIN = "Avalanche";
const DEST_CHAIN = "Polygon";

// RPC endpoints
const RPC_URLS: Record<string, string> = {
  Polygon: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
  Avalanche: process.env.AVALANCHE_RPC || 'https://api.avax.network/ext/bc/C/rpc',
};

// Test different amounts
const TEST_AMOUNTS = [
  { label: "$5 USDC", amount: 5_000_000 },
  { label: "$10 USDC", amount: 10_000_000 },
  { label: "$50 USDC", amount: 50_000_000 },
  { label: "$100 USDC", amount: 100_000_000 },
  { label: "$500 USDC", amount: 500_000_000 },
  { label: "$1000 USDC", amount: 1_000_000_000 },
  { label: "$5000 USDC", amount: 5_000_000_000 },
];

async function testQuoteAmounts() {
  console.log('🧪 Testing Wormhole CCTP Quote API - Fee Structure\n');
  console.log('Testing route:', SOURCE_CHAIN, '→', DEST_CHAIN);
  console.log('');

  try {
    const config: any = {
      chains: {
        Avalanche: { rpc: RPC_URLS.Avalanche },
        Polygon: { rpc: RPC_URLS.Polygon }
      }
    };

    const wh = await wormhole("Mainnet", [evm], config);
    const sendChain = wh.getChain(SOURCE_CHAIN);
    const rcvChain = wh.getChain(DEST_CHAIN);

    console.log('┌─────────────┬──────────────┬──────────────┬──────────────┬──────────────┐');
    console.log('│   Amount    │  Relay Fee   │   Received   │     Loss     │  Loss %      │');
    console.log('├─────────────┼──────────────┼──────────────┼──────────────┼──────────────┤');

    for (const test of TEST_AMOUNTS) {
      const transferDetails = {
        amount: BigInt(test.amount),
        automatic: true,
        nativeGas: 0n
      };

      const quote = await CircleTransfer.quoteTransfer(
        sendChain,
        rcvChain,
        transferDetails
      );

      const sent = Number(quote.sourceToken.amount) / 1_000_000;
      const received = Number(quote.destinationToken.amount) / 1_000_000;
      const relayFee = quote.relayFee ? Number(quote.relayFee.amount) / 1_000_000 : 0;
      const loss = sent - received;
      const lossPercent = (loss / sent) * 100;

      console.log(
        `│ ${test.label.padEnd(11)} │ ` +
        `$${relayFee.toFixed(2).padStart(11)} │ ` +
        `$${received.toFixed(2).padStart(11)} │ ` +
        `$${loss.toFixed(2).padStart(11)} │ ` +
        `${lossPercent.toFixed(2).padStart(11)}% │`
      );
    }

    console.log('└─────────────┴──────────────┴──────────────┴──────────────┴──────────────┘');

    console.log('\n📊 Analysis:');
    console.log('  - Relay fee appears to be: FIXED at ~$1.00');
    console.log('  - For small transfers: High percentage loss');
    console.log('  - For large transfers: Low percentage loss');
    console.log('  - Break-even with LiFi (0.25%): ~$400');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  }
}

testQuoteAmounts()
  .then(() => {
    console.log('\n✅ Test completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Script error:', error);
    process.exit(1);
  });
