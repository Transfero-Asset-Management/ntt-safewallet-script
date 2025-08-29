import { Router, Request, Response } from 'express';
import { Wormhole, amount, Chain } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import "@wormhole-foundation/sdk-evm-ntt";
import { NTT_TOKENS, CHAIN_IDS } from "../utils/const";

const router = Router();

/**
 * POST /api/bridge/estimate
 * Get an estimate for a bridge transfer including exact relay fees
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

    console.log(`[Estimate] Getting quote for ${transferAmount} BRZ from ${sourceChain} to ${destinationChain}`);

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

    // Get chain instances
    const src = wormhole.getChain(srcChain);
    const dst = wormhole.getChain(dstChain);

    const srcChainAddress = Wormhole.chainAddress(src.chain, safeAddress);
    const dstChainAddress = Wormhole.chainAddress(dst.chain, safeAddress);

    // Get NTT protocol instance
    const srcNtt = await src.getProtocol("Ntt", {
      ntt: NTT_TOKENS[src.chain],
    });

    // Parse amount
    const amt = amount.units(
      amount.parse(transferAmount, await srcNtt.getTokenDecimals())
    );

    // Create transfer generator to get transaction details WITHOUT executing
    const xfer = () => srcNtt.transfer(srcChainAddress.address, amt, dstChainAddress, {
      queue: false,
      automatic: true,
      gasDropoff: 0n,
    });

    // Collect transaction details to calculate fees
    const transactions: any[] = [];
    let totalRelayFee = BigInt(0);
    const txGenerator = xfer();
    let step = await txGenerator.next();

    while (!step.done) {
      const transaction = step.value.transaction;
      
      // The value field contains the relay fee in native token
      if (transaction.value) {
        totalRelayFee += BigInt(transaction.value);
      }
      
      transactions.push({
        to: transaction.to,
        value: transaction.value ? transaction.value.toString() : "0",
        data: transaction.data ? transaction.data.substring(0, 10) : "0x" // Just log first 10 chars of data
      });
      
      step = await txGenerator.next();
    }

    console.log(`[Estimate] Found ${transactions.length} transaction(s)`);
    console.log(`[Estimate] Total relay fee: ${totalRelayFee.toString()} wei`);

    // Get native token info
    const nativeTokenSymbol = getNativeToken(srcChain);
    const relayFeeFormatted = formatRelayFee(totalRelayFee, srcChain);

    // Estimate gas for the Safe transaction
    const estimatedGas = BigInt(200000) * BigInt(transactions.length); // Rough estimate

    res.json({
      success: true,
      estimatedFee: relayFeeFormatted,
      maxFee: (Number(relayFeeFormatted) * 1.2).toFixed(6), // 20% buffer
      nativeToken: nativeTokenSymbol,
      gasEstimate: estimatedGas.toString(),
      transactionCount: transactions.length,
      relayFeeWei: totalRelayFee.toString(),
      details: {
        sourceChain: srcChain,
        destinationChain: dstChain,
        amount: transferAmount,
        safeAddress: safeAddress,
        transactions: transactions
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