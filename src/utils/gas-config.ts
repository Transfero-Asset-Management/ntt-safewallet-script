import { JsonRpcProvider } from 'ethers';

export interface GasConfig {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasLimit?: bigint;
}

/**
 * Check if the provider is connected to Unichain
 */
async function isUnichain(provider: JsonRpcProvider): Promise<boolean> {
  try {
    const network = await provider.getNetwork();
    return Number(network.chainId) === 130;
  } catch (error) {
    console.warn('[GasConfig] Could not detect network:', error);
    // Check if the error mentions DRPC batch limits (indicates Unichain with DRPC)
    if (error && typeof error === 'object' && 'info' in error) {
      const info = (error as any).info;
      if (info?.error?.message?.includes('Batch of more than 3 requests')) {
        console.log('[GasConfig] Detected DRPC batch limit error - assuming Unichain');
        return true;
      }
    }
    return false;
  }
}

/**
 * Get gas configuration for Unichain without using batch requests
 */
async function getUnichainGasConfig(provider: JsonRpcProvider): Promise<GasConfig> {
  console.log('[GasConfig] Using Unichain-specific gas configuration (no batch requests)');

  try {
    // Get the latest block to extract base fee
    const block = await provider.getBlock('latest');

    if (block && block.baseFeePerGas) {
      // EIP-1559 network - calculate fees based on base fee
      const baseFee = block.baseFeePerGas;

      // ✅ FIX: Use dynamic priority fee based on base fee, NOT hardcoded 1 gwei
      // Unichain has extremely low gas (< 0.000001 gwei typically)
      // Use 10% of base fee as priority, with minimum of 1 wei to avoid zero
      const maxPriorityFeePerGas = baseFee > BigInt(10)
        ? baseFee / BigInt(10)  // 10% of base fee
        : BigInt(1);            // Minimum 1 wei

      // Set max fee to 2x base fee plus priority fee
      const maxFeePerGas = baseFee * BigInt(2) + maxPriorityFeePerGas;

      console.log(`[GasConfig] Unichain gas prices from block:`);
      console.log(`  - Base fee: ${(Number(baseFee) / 1e9).toFixed(9)} gwei`);
      console.log(`  - Max priority fee: ${(Number(maxPriorityFeePerGas) / 1e9).toFixed(9)} gwei (dynamic: 10% of base)`);
      console.log(`  - Max fee: ${(Number(maxFeePerGas) / 1e9).toFixed(9)} gwei`);

      // Add buffer to prevent failures
      return {
        maxFeePerGas: maxFeePerGas * BigInt(150) / BigInt(100), // 50% buffer
        maxPriorityFeePerGas: maxPriorityFeePerGas * BigInt(150) / BigInt(100), // 50% buffer
      };
    }
  } catch (error) {
    console.error('[GasConfig] Failed to get block data for Unichain:', error);
    // Fail fast - no fallbacks for gas prices to avoid incorrect cost estimation
    throw new Error(`Failed to fetch Unichain gas prices: ${error}`);
  }

  // Should never reach here - if getBlock fails, we throw
  throw new Error('Failed to get Unichain gas configuration');
}

/**
 * Get optimized gas configuration for the current network conditions
 * Adds a buffer to ensure transactions don't fail due to gas price fluctuations
 */
export async function getOptimizedGasConfig(provider: JsonRpcProvider): Promise<GasConfig> {
  try {
    // Check if this is Unichain - use special handling to avoid DRPC batch limits
    const isUnichainNetwork = await isUnichain(provider);

    if (isUnichainNetwork) {
      return await getUnichainGasConfig(provider);
    }

    // For other networks, use the standard getFeeData (which may batch)
    const feeData = await provider.getFeeData();

    if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
      // For networks that don't support EIP-1559, use legacy gasPrice
      if (!feeData.gasPrice) {
        throw new Error('No gas price data available from provider (neither EIP-1559 nor legacy)');
      }
      const gasPrice = feeData.gasPrice;
      return {
        maxFeePerGas: gasPrice * BigInt(150) / BigInt(100), // 50% buffer
        maxPriorityFeePerGas: gasPrice * BigInt(110) / BigInt(100), // 10% buffer
      };
    }

    // Add buffer to gas prices to prevent "max fee per gas less than block base fee" errors
    const maxFeePerGas = feeData.maxFeePerGas * BigInt(150) / BigInt(100); // 50% buffer
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas * BigInt(150) / BigInt(100); // 50% buffer

    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
  } catch (error) {
    // Check if this is a DRPC batch limit error
    if (error && typeof error === 'object' && 'info' in error) {
      const info = (error as any).info;
      if (info?.error?.message?.includes('Batch of more than 3 requests')) {
        console.log('[GasConfig] Encountered DRPC batch limit - retrying with Unichain config');
        return await getUnichainGasConfig(provider);
      }
    }

    console.error('[GasConfig] Error getting fee data:', error);
    // Fail fast - no fallbacks for gas prices to avoid incorrect cost estimation
    throw new Error(`Failed to fetch gas prices: ${error}`);
  }
}