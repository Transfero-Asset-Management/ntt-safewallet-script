import { Router, Request, Response } from 'express';
import { BridgeService } from '../services/bridge.service';
import { TransferRequest, TransferStatus } from '../types/bridge.types';

const router = Router();
const bridgeService = new BridgeService();

/**
 * POST /api/bridge/transfer
 * Initiate a cross-chain BRZ transfer
 */
router.post('/transfer', async (req: Request, res: Response, next: Function) => {
  try {
    // Log raw request body first
    console.log('[Bridge Routes] Raw request body:', JSON.stringify(req.body, null, 2));
    
    const transferRequest: TransferRequest = {
      sourceChain: req.body.sourceChain,
      destinationChain: req.body.destinationChain,
      amount: req.body.amount,
      safeAddress: req.body.safeAddress,
      destinationAddress: req.body.destinationAddress || req.body.safeAddress, // Default to same address
      sourceRpcUrl: req.body.sourceRpcUrl,  // Pass RPC URL if provided
      destRpcUrl: req.body.destRpcUrl       // Pass RPC URL if provided
    };
    
    console.log('[Bridge Routes] Parsed transfer request:', JSON.stringify(transferRequest, null, 2));

    // Validate request
    if (!transferRequest.sourceChain || !transferRequest.destinationChain || 
        !transferRequest.amount || !transferRequest.safeAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: sourceChain, destinationChain, amount, safeAddress'
      });
    }

    console.log(`[Bridge] Transfer request:`, transferRequest);

    // Initiate transfer
    const result = await bridgeService.initiateTransfer(transferRequest);

    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/bridge/transfer/:transferId
 * Get transfer status by ID
 */
router.get('/transfer/:transferId', async (req: Request, res: Response, next: Function) => {
  try {
    const { transferId } = req.params;
    
    const status = await bridgeService.getTransferStatus(transferId);
    
    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Transfer not found'
      });
    }

    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/bridge/resume/:txHash
 * Resume a stuck transfer by transaction hash
 */
router.post('/resume/:txHash', async (req: Request, res: Response, next: Function) => {
  try {
    const { txHash } = req.params;
    
    console.log(`[Bridge] Resuming transfer for tx: ${txHash}`);
    
    const result = await bridgeService.resumeTransfer(txHash);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/bridge/chains
 * Get supported chains and their configurations
 */
router.get('/chains', async (req: Request, res: Response) => {
  const chains = bridgeService.getSupportedChains();
  
  res.json({
    success: true,
    data: chains
  });
});

export const bridgeRoutes = router;