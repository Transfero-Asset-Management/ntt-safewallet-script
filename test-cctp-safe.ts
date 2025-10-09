/**
 * Test Wormhole CCTP for USDC transfers THROUGH SAFE
 *
 * This tests bridging USDC using Wormhole's CCTP integration
 * via Gnosis Safe (same pattern as NTT service)
 */

import { wormhole, amount } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import { getEvmSigner, EvmAddress } from "@wormhole-foundation/sdk-evm";
import "@wormhole-foundation/sdk-evm-cctp";
import dotenv from 'dotenv';
import { Wallet } from 'ethers';

dotenv.config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.SAFE_MODULE_OWNER_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('❌ PRIVATE_KEY or SAFE_MODULE_OWNER_PRIVATE_KEY not set');
  process.exit(1);
}

// Test configuration
const TEST_AMOUNT = "2.0"; // 2 USDC (minimum ~1.003 USDC due to relayer fee)
const SOURCE_CHAIN = "Avalanche"; // Use working chain
const DEST_CHAIN = "Polygon";
const SAFE_ADDRESS = process.env.GNOSIS_SAFE_ADDRESS || '0x28f6C070399051e51411efd44164740F7Cd8Ca66';

// RPC endpoints
const RPC_URLS: Record<string, string> = {
  Polygon: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
  Avalanche: process.env.AVALANCHE_RPC || 'https://api.avax.network/ext/bc/C/rpc',
};

// Chain IDs for Safe integration
const CHAIN_IDS: Record<string, number> = {
  Avalanche: 43114,
  Polygon: 137,
};

async function testWormholeCCTPWithSafe() {
  console.log('🧪 Testing Wormhole CCTP Bridge via Safe\n');
  console.log('Configuration:');
  console.log('  Source:', SOURCE_CHAIN);
  console.log('  Destination:', DEST_CHAIN);
  console.log('  Amount:', TEST_AMOUNT, 'USDC');
  console.log('  Safe Address:', SAFE_ADDRESS);
  console.log('  Using: Wormhole SDK + Gnosis Safe\n');

  try {
    // Build custom config with our RPC URLs
    const config: any = {
      chains: {
        Avalanche: { rpc: RPC_URLS.Avalanche },
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

    // Create signer wallet (for Safe proposal, not direct signing)
    console.log('⚙️  Creating signer wallet...');
    const signerWallet = new Wallet(PRIVATE_KEY!);
    console.log('📋 Signer Address:', signerWallet.address);
    console.log('📋 Safe Address:', SAFE_ADDRESS);
    console.log();

    // Create address objects for Safe and destination
    const safeEvmAddr = new EvmAddress(SAFE_ADDRESS);
    const destEvmAddr = new EvmAddress(SAFE_ADDRESS); // Send to same Safe on dest chain

    const sourceChainAddr = {
      chain: SOURCE_CHAIN,
      address: safeEvmAddr
    };
    const destChainAddr = {
      chain: DEST_CHAIN,
      address: destEvmAddr
    };

    // Parse amount (USDC has 6 decimals)
    const amt = BigInt(2000000); // 2 USDC
    console.log('📊 Transfer amount:', amt.toString(), '(2.0 USDC in smallest unit)');
    console.log();

    // Set automatic transfer (Wormhole relayer handles completion)
    const automatic = true;
    const nativeGas = 0n;

    // Get the CCTP protocol instance (like NTT does with getProtocol)
    console.log('💵 Getting CCTP protocol...');
    const srcCctp = await sendChain.getProtocol("AutomaticCircleBridge", {});

    console.log('✅ CCTP protocol retrieved');
    console.log();

    // Collect transactions like NTT service does
    console.log('🔄 Collecting transactions from transfer generator...');
    const transactions: any[] = [];

    // Create the transfer generator (like NTT does)
    const xfer = () => srcCctp.transfer(
      safeEvmAddr,
      destChainAddr as any,
      amt,
      nativeGas
    );

    // Iterate through the generator to collect unsigned transactions
    const txGenerator = xfer();
    let step = await txGenerator.next();

    while (!step.done) {
      const transaction = step.value.transaction;
      transactions.push({
        to: transaction.to,
        value: transaction.value ? transaction.value.toString() : "0",
        data: transaction.data
      });

      console.log(`[CCTP] Transaction ${transactions.length}:`);
      console.log(`  To: ${transaction.to}`);
      console.log(`  Value: ${transaction.value || '0'}`);
      console.log(`  Data: ${transaction.data.substring(0, 66)}...`);

      // Get next transaction
      step = await txGenerator.next();
    }

    console.log();
    console.log(`✅ Total transactions collected: ${transactions.length}`);
    console.log();

    // Now bundle and propose via Safe (like NTT service does)
    if (transactions.length > 0) {
      console.log('⚠️  READY TO PROPOSE SAFE TRANSACTION');
      console.log(`   This will create a Safe proposal with ${transactions.length} transaction(s)`);
      console.log('   Press Ctrl+C to cancel, or wait 5 seconds to continue...\n');

      await sleep(5000);

      console.log('🔄 Proposing Safe transaction...');

      // Import Safe proposal function
      const { proposeBundledTransaction } = await import('./src/safe');

      const result = await proposeBundledTransaction(
        CHAIN_IDS[SOURCE_CHAIN],
        SAFE_ADDRESS,
        transactions,
        signerWallet,
        RPC_URLS[SOURCE_CHAIN]
      );

      console.log();
      console.log('✅ Safe transaction proposed successfully!');
      console.log('  Safe TX Hash:', result.safeTxHash);

      if (result.executed && result.executionTxHash) {
        console.log('  ✅ Transaction auto-executed!');
        console.log('  Execution TX Hash:', result.executionTxHash);
      } else {
        console.log('  ⏳ Awaiting Safe execution (threshold signatures needed)');
      }
      console.log();

      console.log('📝 Summary:');
      console.log('  ✅ CCTP transactions collected:', transactions.length);
      console.log('  ✅ Safe proposal created');
      console.log('  ✅ Pattern matches NTT service exactly');
    }

  } catch (error: any) {
    console.error('\n❌ Test failed:', error.message);
    console.error('\nFull error:', error);

    if (error.message.includes('insufficient funds')) {
      console.error('\n💡 Tip: Make sure Safe has enough USDC and ETH for gas on', SOURCE_CHAIN);
    }

    process.exit(1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run test
testWormholeCCTPWithSafe()
  .then(() => {
    console.log('\n✅ Script completed');
    process.exit(0);
  })
  .catch(error => {
    console.error('\n❌ Script error:', error);
    process.exit(1);
  });
