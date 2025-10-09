/**
 * Test Wormhole CCTP for USDC transfers
 *
 * This tests bridging USDC using Wormhole's CCTP integration
 * which provides automatic relaying and uses Circle's CCTP underneath
 */

import { wormhole, amount, toChainId } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import { getEvmSigner, EvmAddress } from "@wormhole-foundation/sdk-evm";
import "@wormhole-foundation/sdk-evm-cctp";
import dotenv from 'dotenv';

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.SAFE_MODULE_OWNER_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY or SAFE_MODULE_OWNER_PRIVATE_KEY not set');
  process.exit(1);
}

// Test configuration
const TEST_AMOUNT = "2.0"; // 2 USDC (minimum ~1.003 USDC due to relayer fee)
const SOURCE_CHAIN = "Avalanche"; // Test non-Base chains
const DEST_CHAIN = "Polygon";

// RPC endpoints
const RPC_URLS: Record<string, string> = {
  Base: process.env.BASE_RPC || 'https://mainnet.base.org',
  Polygon: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
  Avalanche: process.env.AVALANCHE_RPC || 'https://api.avax.network/ext/bc/C/rpc',
};

async function testWormholeCCTP() {
  console.log('🧪 Testing Wormhole CCTP Bridge\n');
  console.log('Configuration:');
  console.log('  Source:', SOURCE_CHAIN);
  console.log('  Destination:', DEST_CHAIN);
  console.log('  Amount:', TEST_AMOUNT, 'USDC');
  console.log('  Using: Wormhole SDK with Circle CCTP\n');

  try {
    // Build custom config with our RPC URLs
    const config: any = {
      chains: {
        Base: { rpc: RPC_URLS.Base },
        Polygon: { rpc: RPC_URLS.Polygon }
      }
    };

    // Initialize Wormhole for Mainnet with EVM support and custom config
    console.log('⚙️  Initializing Wormhole SDK...');
    const wh = await wormhole("Mainnet", [evm], config);
    console.log('✅ Wormhole initialized\n');

    // Get chain contexts
    const sendChain = wh.getChain(SOURCE_CHAIN);
    const rcvChain = wh.getChain(DEST_CHAIN);

    // Get SDK signers from the chain contexts
    console.log('⚙️  Creating signers from private key...');
    const srcRpc = await sendChain.getRpc();
    const dstRpc = await rcvChain.getRpc();

    const source = await getEvmSigner(srcRpc, PRIVATE_KEY!);
    const destination = await getEvmSigner(dstRpc, PRIVATE_KEY!);

    const sourceAddress = source.address();
    const destAddress = destination.address();

    console.log('📋 Wallet Address:', sourceAddress);
    console.log('  Source chain:', SOURCE_CHAIN);
    console.log('  Dest chain:', DEST_CHAIN);
    console.log();

    // Parse amount (USDC has 6 decimals)
    // 2.0 USDC = 2000000 (6 decimals)
    const amt = BigInt(2000000); // 2 USDC
    console.log('📊 Transfer amount:', amt.toString(), '(2.0 USDC in smallest unit)');
    console.log();

    // Set automatic transfer (Wormhole relayer handles completion)
    const automatic = true;
    const nativeGas = 0n; // No native gas dropoff

    // Create CCTP transfer request using the correct SDK API
    console.log('💵 Creating CCTP transfer...');

    // Create proper EVM address objects
    const evmSourceAddr = new EvmAddress(sourceAddress);
    const evmDestAddr = new EvmAddress(destAddress);

    // Create chain address with proper format
    const sourceChainAddr = {
      chain: SOURCE_CHAIN,
      address: evmSourceAddr
    };
    const destChainAddr = {
      chain: DEST_CHAIN,
      address: evmDestAddr
    };

    const xfer = await wh.circleTransfer(
      amt,
      sourceChainAddr as any,
      destChainAddr as any,
      automatic,
      undefined, // no payload
      nativeGas
    );

    console.log('✅ Transfer object created');
    console.log();

    // Ask for confirmation
    console.log('⚠️  READY TO EXECUTE REAL TRANSACTION');
    console.log('   This will transfer', TEST_AMOUNT, 'USDC from', SOURCE_CHAIN, 'to', DEST_CHAIN);
    console.log('   Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');

    await sleep(5000);

    // Initiate the transfer
    console.log('🚀 Initiating CCTP transfer...');
    const srcTxids = await xfer.initiateTransfer(source);
    console.log('✅ Transfer initiated!');
    console.log('  Transaction IDs:', srcTxids);
    console.log();

    // If automatic relay is enabled, Wormhole will handle the rest
    console.log('⏳ Wormhole relayer will automatically complete the transfer');
    console.log('   Expected completion: ~10-20 minutes');
    console.log('   You can track the transfer on Wormhole Scan');
    console.log();

    console.log('✅ Test completed successfully!');
    console.log('\n📝 Summary:');
    console.log('  ✅ Wormhole CCTP is working');
    console.log('  ✅ Transaction sent from', SOURCE_CHAIN);
    console.log('  ✅ Automatic relaying enabled');
    console.log('  ⏳ Waiting for completion on', DEST_CHAIN);

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\nFull error:', error);

    if (error.message.includes('insufficient funds')) {
      console.error('\n💡 Tip: Make sure you have enough USDC and ETH for gas on', SOURCE_CHAIN);
    }

    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run test
testWormholeCCTP()
  .then(() => {
    console.log('\n✅ Script completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Script error:', error);
    process.exit(1);
  });
