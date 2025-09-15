import { JsonRpcProvider } from 'ethers';

/**
 * Create a JsonRpcProvider with retry logic for connection failures
 * @param rpcUrl The RPC URL to connect to
 * @param maxRetries Maximum number of retry attempts (default: 3)
 * @param retryDelay Delay between retries in milliseconds (default: 2000)
 * @returns JsonRpcProvider instance
 */
export async function createProviderWithRetry(
  rpcUrl: string,
  maxRetries: number = 3,
  retryDelay: number = 2000
): Promise<JsonRpcProvider> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[RPC] Attempting to connect to provider (attempt ${attempt}/${maxRetries})...`);

      // Create provider with increased timeout
      const provider = new JsonRpcProvider(rpcUrl, undefined, {
        staticNetwork: true, // Skip network detection on initialization
        timeout: 30000 // 30 second timeout
      });

      // Try to get the network to verify connection
      // Use a timeout to avoid hanging indefinitely
      const networkPromise = provider.getNetwork();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Network detection timeout')), 10000)
      );

      try {
        await Promise.race([networkPromise, timeoutPromise]);
        console.log(`[RPC] Successfully connected to provider`);
        return provider;
      } catch (networkError) {
        // If network detection fails, but we want to proceed anyway
        if (attempt === maxRetries) {
          console.warn(`[RPC] Network detection failed, but proceeding with provider`);
          return provider; // Return the provider even if network detection failed
        }
        throw networkError;
      }

    } catch (error) {
      lastError = error as Error;
      console.error(`[RPC] Connection attempt ${attempt} failed:`, error);

      if (attempt < maxRetries) {
        console.log(`[RPC] Retrying in ${retryDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  throw new Error(`Failed to connect to RPC after ${maxRetries} attempts: ${lastError?.message}`);
}

/**
 * Wrapper for JsonRpcProvider that adds retry logic on initialization
 */
export class RetryableJsonRpcProvider extends JsonRpcProvider {
  static async create(
    rpcUrl: string,
    maxRetries: number = 3,
    retryDelay: number = 2000
  ): Promise<JsonRpcProvider> {
    return createProviderWithRetry(rpcUrl, maxRetries, retryDelay);
  }
}