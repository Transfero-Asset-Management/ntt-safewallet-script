import { Router, Request, Response } from 'express';
import { Wormhole, Chain, routes } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import "@wormhole-foundation/sdk-evm-ntt";
import { nttExecutorRoute, NttExecutorRoute } from "@wormhole-foundation/sdk-route-ntt";
import { NTT_TOKENS, CHAIN_IDS } from "../utils/const";

const router = Router();

/**
 * Build executor config from NTT_TOKENS
 */
function buildExecutorConfig(): NttExecutorRoute.Config {
  const tokens = Object.entries(NTT_TOKENS)
    .filter(([_, contracts]) => contracts !== undefined)
    .map(([chain, contracts]) => ({
      chain: chain as Chain,
      token: contracts!.token,
      manager: contracts!.manager,
      transceiver: Object.entries(contracts!.transceiver).map(([type, address]) => ({
        type: type as "wormhole",
        address: address as string,
      })),
    }));

  return {
    ntt: {
      tokens: {
        "BRZ": tokens
      }
    },
    referrerFee: {
      feeDbps: 0n, // No referrer fee
    }
  };
}

/**
 * POST /api/bridge/estimate
 * Get an estimate for a bridge transfer using Executor quotes
 */
router.post('/', async (req: Request, res: Response, next: Function) => {
  try {
    const { sourceChain, destinationChain, amount: transferAmount, safeAddress, sourceRpcUrl, destRpcUrl } = req.body;

    if (!sourceChain || !destinationChain || !transferAmount || !safeAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: sourceChain, destinationChain, amount, safeAddress'
      });
    }

    console.log(`[Estimate] Getting executor quote for ${transferAmount} BRZ from ${sourceChain} to ${destinationChain}`);

    // Normalize chain names
    const normalizeChainName = (chainName: string): Chain => {
      const chainMap: { [key: string]: Chain } = {
        'base': 'Base' as Chain,
        'polygon': 'Polygon' as Chain,
        'arbitrum': 'Arbitrum' as Chain,
        'avalanche': 'Avalanche' as Chain,
        'bsc': 'Bsc' as Chain,
        'unichain': 'Unichain' as Chain
      };
      const normalized = chainMap[chainName.toLowerCase()];
      if (!normalized) {
        throw new Error(`Unsupported chain: ${chainName}`);
      }
      return normalized;
    };

    const srcChain = normalizeChainName(sourceChain);
    const dstChain = normalizeChainName(destinationChain);

    // Build chain config - RPCs MUST be provided
    const buildChainConfig = (sourceRpc?: string, destRpc?: string): any => {
      if (!sourceRpc || !destRpc) {
        throw new Error('RPC URLs must be provided for source and destination chains');
      }

      const config: any = { chains: {} };

      for (const chain of Object.keys(CHAIN_IDS)) {
        let rpcUrl = "";

        // Set RPC for source and destination chains
        if (chain === srcChain) {
          rpcUrl = sourceRpc;
          console.log(`[Estimate] Using RPC for source ${chain}: ${rpcUrl.substring(0, 40)}...`);
        } else if (chain === dstChain) {
          rpcUrl = destRpc;
          console.log(`[Estimate] Using RPC for dest ${chain}: ${rpcUrl.substring(0, 40)}...`);
        }

        // Only add chains with RPCs
        if (rpcUrl) {
          config.chains[chain] = {
            rpc: rpcUrl
          };
        }
      }

      return config;
    };

    // Initialize Wormhole with custom RPCs if provided
    const wormhole = new Wormhole("Mainnet", [evm.Platform], {
      chains: buildChainConfig(sourceRpcUrl, destRpcUrl).chains
    });

    // Setup executor route
    const executorConfig = buildExecutorConfig();
    const executorRoute = nttExecutorRoute(executorConfig);
    const routeInstance = new executorRoute(wormhole as any);

    // Create transfer request
    const srcTokenAddr = NTT_TOKENS[srcChain]!.token;
    const dstTokenAddr = NTT_TOKENS[dstChain]!.token;

    const tr = await routes.RouteTransferRequest.create(wormhole as any, {
      source: Wormhole.tokenId(srcChain, srcTokenAddr),
      destination: Wormhole.tokenId(dstChain, dstTokenAddr),
    });

    // Validate parameters
    const validated = await routeInstance.validate(tr, { amount: transferAmount });
    if (!validated.valid) {
      throw new Error(`Executor validation failed: ${validated.error?.message || 'Unknown error'}`);
    }

    // Get quote from executor (replaces quoteDeliveryPrice from Standard Relayer)
    console.log(`[Estimate] Fetching executor quote...`);
    const executorQuote = await routeInstance.fetchExecutorQuote(tr, validated.params as NttExecutorRoute.ValidatedParams);

    console.log(`[Estimate] Executor quote received:`);
    console.log(`  Estimated cost: ${executorQuote.estimatedCost.toString()} wei`);
    console.log(`  Expires: ${executorQuote.expires.toISOString()}`);

    // Get native token info
    const nativeTokenSymbol = getNativeToken(srcChain);

    // Format the relay fee for response
    const relayFeeFormatted = formatRelayFee(executorQuote.estimatedCost, srcChain);

    console.log(`[Estimate] Executor fee: ${relayFeeFormatted} ${nativeTokenSymbol}`);

    // Return the executor quote
    res.json({
      success: true,
      estimatedFee: relayFeeFormatted, // Executor fee in native token
      maxFee: (Number(relayFeeFormatted) * 1.2).toFixed(6), // 20% buffer
      nativeToken: nativeTokenSymbol,
      gasEstimate: executorQuote.estimatedCost.toString(), // Estimated cost in wei
      transactionCount: 1,
      relayFeeWei: executorQuote.estimatedCost.toString(), // Estimated cost in wei
      expiresAt: executorQuote.expires.toISOString(),
      note: 'This is the Executor relay fee. Quote expires at the specified time.',
      details: {
        sourceChain: srcChain,
        destinationChain: dstChain,
        amount: transferAmount,
        safeAddress: safeAddress
      }
    });

  } catch (error: any) {
    console.error('[Estimate] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get transfer estimate'
    });
  }
});

// Helper functions
function getNativeToken(chain: string): string {
  const tokens: Record<string, string> = {
    'Base': 'ETH',
    'Polygon': 'POL',
    'Arbitrum': 'ETH',
    'Avalanche': 'AVAX',
    'Bsc': 'BNB',
    'Unichain': 'ETH'
  };
  return tokens[chain] || 'ETH';
}

function formatRelayFee(feeWei: bigint, chain: string): string {
  // Convert wei to native token (18 decimals for most chains)
  const decimals = 18;
  const divisor = BigInt(10 ** decimals);
  const wholePart = feeWei / divisor;
  const fractionalPart = feeWei % divisor;

  // Format to 6 decimal places
  const fractionalStr = fractionalPart.toString().padStart(decimals, '0').substring(0, 6);
  const formatted = `${wholePart}.${fractionalStr}`;

  // Remove trailing zeros
  return parseFloat(formatted).toString();
}

export const estimateRoutes = router;
