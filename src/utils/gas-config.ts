import { JsonRpcProvider } from 'ethers';

export interface GasConfig {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasLimit?: bigint;
}

/**
 * Get optimized gas configuration for the current network conditions
 * Adds a buffer to ensure transactions don't fail due to gas price fluctuations
 */
export async function getOptimizedGasConfig(provider: JsonRpcProvider): Promise<GasConfig> {
  try {
    // Get current gas prices
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
    console.error('[GasConfig] Error getting fee data:', error);
    // Return safe defaults
    return {
      maxFeePerGas: BigInt(50000000000), // 50 gwei
      maxPriorityFeePerGas: BigInt(2000000000), // 2 gwei
    };
  }
}