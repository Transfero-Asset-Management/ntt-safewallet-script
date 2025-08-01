import { Router, Request, Response } from 'express';
import { BridgeService } from '../services/bridge.service';

const router = Router();
const bridgeService = new BridgeService();

/**
 * GET /api/status/transfers
 * Get recent transfers with optional filters
 */
router.get('/transfers', async (req: Request, res: Response, next: Function) => {
  try {
    const { status, sourceChain, destinationChain, limit = 10 } = req.query;
    
    const transfers = await bridgeService.getRecentTransfers({
      status: status as string,
      sourceChain: sourceChain as string,
      destinationChain: destinationChain as string,
      limit: Number(limit)
    });

    res.json({
      success: true,
      data: transfers
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/status/safe/:safeAddress
 * Get all transfers for a specific Safe
 */
router.get('/safe/:safeAddress', async (req: Request, res: Response, next: Function) => {
  try {
    const { safeAddress } = req.params;
    const { limit = 20 } = req.query;
    
    const transfers = await bridgeService.getTransfersBySafe(safeAddress, Number(limit));
    
    res.json({
      success: true,
      data: transfers
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/status/metrics
 * Get bridge service metrics
 */
router.get('/metrics', async (req: Request, res: Response, next: Function) => {
  try {
    const metrics = await bridgeService.getMetrics();
    
    res.json({
      success: true,
      data: metrics
    });
  } catch (error) {
    next(error);
  }
});

export const statusRoutes = router;