import { Router, Request, Response } from 'express';
// Import CCTP support BEFORE BridgeService to ensure protocol registration
import "@wormhole-foundation/sdk-evm-cctp";
import { BridgeService } from '../services/bridge.service';

const router = Router();
const bridgeService = new BridgeService();

/**
 * POST /api/bridge/quote
 * Get a quote for CCTP bridge transfer (USDC/USDT)
 * Includes relay fee estimation
 */
router.post('/', async (req: Request, res: Response, next: Function) => {
  try {
    const { sourceChain, destinationChain, token, amount, sourceRpcUrl, destRpcUrl } = req.body;

    if (!sourceChain || !destinationChain || !token || !amount) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: sourceChain, destinationChain, token, amount'
      });
    }

    // Validate token
    if (token !== 'USDC' && token !== 'USDT') {
      return res.status(400).json({
        success: false,
        error: 'Token must be USDC or USDT. Use /api/bridge/estimate for BRZ.'
      });
    }

    console.log(`[Quote] Getting CCTP quote for ${amount} ${token} from ${sourceChain} to ${destinationChain}`);

    // Get quote from bridge service
    const quote = await bridgeService.getCCTPQuote(
      sourceChain,
      destinationChain,
      token,
      amount,
      sourceRpcUrl,
      destRpcUrl
    );

    res.json({
      success: true,
      quote: {
        sourceAmount: quote.sourceAmount,
        destinationAmount: quote.destinationAmount,
        relayFee: quote.relayFee,
        relayFeeUSD: quote.relayFeeUSD,
        destinationNativeGas: quote.destinationNativeGas,
        eta: quote.eta,
        expires: quote.expires,
        token: token,
        sourceChain: sourceChain,
        destinationChain: destinationChain
      }
    });

  } catch (error: any) {
    console.error('[Quote] Error:', error);

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get CCTP quote'
    });
  }
});

export const quoteRoutes = router;
