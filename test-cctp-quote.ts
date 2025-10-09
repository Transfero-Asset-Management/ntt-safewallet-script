/**
 * Test Wormhole CCTP Quote API
 *
 * This tests getting a quote for CCTP transfer to see the relayer fee
 * BEFORE executing the actual transfer.
 */

import { wormhole, amount } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import { EvmAddress } from "@wormhole-foundation/sdk-evm";
import "@wormhole-foundation/sdk-evm-cctp";
import dotenv from 'dotenv';

dotenv.config();

// Test configuration
const TEST_AMOUNT = "2.0"; // 2 USDC
const SOURCE_CHAIN = "Avalanche";
const DEST_CHAIN = "Polygon";
const SAFE_ADDRESS = process.env.GNOSIS_SAFE_ADDRESS || '0x28f6C070399051e51411efd44164740F7Cd8Ca66';

// RPC endpoints
const RPC_URLS: Record<string, string> = {
  Polygon: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
  Avalanche: process.env.AVALANCHE_RPC || 'https://api.avax.network/ext/bc/C/rpc',
};

async function testCCTPQuote() {
  console.log('🧪 Testing Wormhole CCTP Quote API\n');
  console.log('Configuration:');
  console.log('  Source:', SOURCE_CHAIN);
  console.log('  Destination:', DEST_CHAIN);
  console.log('  Amount:', TEST_AMOUNT, 'USDC');
  console.log('  Safe Address:', SAFE_ADDRESS);
  console.log('\n📊 Getting quote (NO actual transfer)...\n');

  try {
    // Build custom config with our RPC URLs
    const config: any = {
      chains: {
        Avalanche: { rpc: RPC_URLS.Avalanche },
        Polygon: { rpc: RPC_URLS.Polygon }
      }
    };

    // Initialize Wormhole for Mainnet with EVM support
    console.log('⚙️  Initializing Wormhole SDK...');
    const wh = await wormhole("Mainnet", [evm], config);
    console.log('✅ Wormhole initialized\n');

    // Get chain contexts
    const sendChain = wh.getChain(SOURCE_CHAIN);
    const rcvChain = wh.getChain(DEST_CHAIN);

    // Create address objects
    const safeEvmAddr = new EvmAddress(SAFE_ADDRESS);

    const sourceChainAddr = {
      chain: SOURCE_CHAIN,
      address: safeEvmAddr
    };
    const destChainAddr = {
      chain: DEST_CHAIN,
      address: safeEvmAddr
    };

    // Parse amount (USDC has 6 decimals)
    const amt = BigInt(2000000); // 2 USDC
    console.log('📊 Transfer amount:', amt.toString(), '(2.0 USDC in smallest unit)');
    console.log();

    // Get the CCTP protocol instance
    console.log('💵 Getting CCTP protocol...');
    const srcCctp = await sendChain.getProtocol("AutomaticCircleBridge", {});
    console.log('✅ CCTP protocol retrieved\n');

    // Get a quote using CircleTransfer.quoteTransfer (static function)
    console.log('📋 Requesting transfer quote...');

    // Import CircleTransfer for the quote function
    const { CircleTransfer } = await import("@wormhole-foundation/sdk-connect");

    // Create transfer details (without from/to addresses as per API)
    const transferDetails = {
      amount: amt,
      automatic: true,
      nativeGas: 0n
    };

    const quote = await CircleTransfer.quoteTransfer(
      sendChain,
      rcvChain,
      transferDetails
    );

    console.log('\n✅ Quote received!\n');
    console.log('📊 Quote Details:');
    console.log(JSON.stringify(quote, (key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    , 2));

    // Parse quote details
    console.log('\n💰 Fee Breakdown:');
    if (quote.relayFee) {
      const relayFeeUSDC = Number(quote.relayFee.amount) / 1_000_000; // Convert from smallest unit
      console.log('  Relay Fee:', relayFeeUSDC.toFixed(6), 'USDC (~$' + relayFeeUSDC.toFixed(2) + ')');
    }
    if (quote.sourceToken?.amount) {
      const sourceAmount = Number(quote.sourceToken.amount) / 1_000_000;
      console.log('  Source Amount:', sourceAmount.toFixed(6), 'USDC');
    }
    if (quote.destinationToken?.amount) {
      const destAmount = Number(quote.destinationToken.amount) / 1_000_000;
      console.log('  Destination Amount:', destAmount.toFixed(6), 'USDC');

      if (quote.sourceToken?.amount) {
        const loss = Number(quote.sourceToken.amount - quote.destinationToken.amount) / 1_000_000;
        const lossPercent = (loss / Number(quote.sourceToken.amount / 1_000_000n)) * 100;
        console.log('  Total Loss:', loss.toFixed(6), 'USDC (' + lossPercent.toFixed(2) + '%)');
      }
    }

    console.log('\n📝 Summary:');
    console.log('  ✅ Quote API test completed');
    console.log('  ✅ No actual transfer was executed');
    console.log('  ✅ Based on previous test: Relayer fee is ~$1.00 fixed');
    console.log('  ✅ For 2 USDC transfer: Sent 2.0, Received ~0.99 USDC');

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\nFull error:', error);
    process.exit(1);
  }
}

// Run test
testCCTPQuote()
  .then(() => {
    console.log('\n✅ Script completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Script error:', error);
    process.exit(1);
  });
