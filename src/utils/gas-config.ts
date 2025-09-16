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
      // Use a reasonable priority fee for Unichain
      const maxPriorityFeePerGas = BigInt(1000000000); // 1 gwei
      // Set max fee to 2x base fee plus priority fee
      const maxFeePerGas = baseFee * BigInt(2) + maxPriorityFeePerGas;

      console.log(`[GasConfig] Unichain gas prices from block:`);
      console.log(`  - Base fee: ${(Number(baseFee) / 1e9).toFixed(3)} gwei`);
      console.log(`  - Max priority fee: ${(Number(maxPriorityFeePerGas) / 1e9).toFixed(3)} gwei`);
      console.log(`  - Max fee: ${(Number(maxFeePerGas) / 1e9).toFixed(3)} gwei`);

      // Add buffer to prevent failures
      return {
        maxFeePerGas: maxFeePerGas * BigInt(150) / BigInt(100), // 50% buffer
        maxPriorityFeePerGas: maxPriorityFeePerGas * BigInt(150) / BigInt(100), // 50% buffer
      };
    }
  } catch (error) {
    console.warn('[GasConfig] Could not get block data for Unichain:', error);
  }

  // Fallback for Unichain - use conservative defaults
  console.log('[GasConfig] Using fallback gas prices for Unichain');
  return {
    maxFeePerGas: BigInt(5000000000), // 5 gwei (Unichain is typically cheap)
    maxPriorityFeePerGas: BigInt(1500000000), // 1.5 gwei
  };
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
      // Fallback for networks that don't support EIP-1559
      const gasPrice = feeData.gasPrice || BigInt(20000000000); // 20 gwei default
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
    // Return safe defaults
    return {
      maxFeePerGas: BigInt(50000000000), // 50 gwei
      maxPriorityFeePerGas: BigInt(2000000000), // 2 gwei
    };
  }
}