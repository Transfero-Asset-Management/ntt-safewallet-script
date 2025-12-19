import { Wormhole, wormhole, amount, Chain, routes } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/evm";
import { Wallet } from "ethers";
import "@wormhole-foundation/sdk-evm-ntt";
import "@wormhole-foundation/sdk-evm-cctp";
import { CircleTransfer } from "@wormhole-foundation/sdk-connect";
import { EvmAddress } from "@wormhole-foundation/sdk-evm";
import { nttExecutorRoute, NttExecutorRoute } from "@wormhole-foundation/sdk-route-ntt";
import { NttWithExecutor } from "@wormhole-foundation/sdk-definitions-ntt";

import { NTT_TOKENS, CHAIN_IDS } from "../utils/const";
import { proposeTransaction } from "../safe";
import {
  TransferRequest,
  TransferResult,
  TransferStatus,
  Transfer,
  BridgeMetrics,
  CCTPQuoteResult
} from "../types/bridge.types";
import { RebalanceDbService } from "./rebalance-db.service";

export class BridgeService {
  private wormhole: Wormhole<any>;
  private transfers: Map<string, Transfer> = new Map();
  private signerWallet: any; // Changed to any to handle both Wallet types
  private dbService: RebalanceDbService;

  constructor() {
    // Wormhole will be initialized when transfer is requested with RPCs
    // No more default initialization with hardcoded endpoints
    this.wormhole = null as any; // Will be set in initiateTransfer
    
    // Initialize signer wallet - try multiple env var names for compatibility
    const privateKey = process.env.SAFE_MODULE_OWNER_PRIVATE_KEY || 
                      process.env.PRIVATE_KEY || 
                      process.env.ETH_PRIVATE_KEY;
    if (!privateKey) {
      console.warn('Private key not set (SAFE_MODULE_OWNER_PRIVATE_KEY, PRIVATE_KEY, or ETH_PRIVATE_KEY) - bridge service will not be able to propose transactions');
      this.signerWallet = Wallet.createRandom(); // Dummy wallet for read-only operations
    } else {
      this.signerWallet = new Wallet(privateKey);
      console.log(`[Bridge] Initialized with signer address: ${this.signerWallet.address}`);
    }

    // Initialize database service
    this.dbService = new RebalanceDbService();
  }

  private buildChainConfig(rpcs: { source: string; dest: string; sourceChain: string; destChain: string }): any {
    const config: any = { chains: {} };

    // Build config for all supported chains
    for (const chain of Object.keys(CHAIN_IDS)) {
      // Use provided RPCs for source and destination chains
      let rpcUrl = "";

      if (rpcs.sourceChain === chain) {
        // Force proper RPC for Unichain if it's using DRPC
        if (chain === 'Unichain' && rpcs.source.includes('drpc.org')) {
          // Override with a better RPC for Unichain
          rpcUrl = process.env.UNICHAIN_RPC || 'https://mainnet.unichain.org';
          console.log(`[Bridge] Overriding Unichain RPC (was DRPC): ${rpcUrl.substring(0, 40)}...`);
        } else {
          rpcUrl = rpcs.source;
          console.log(`[Bridge] Setting RPC for source chain ${chain}: ${rpcUrl.substring(0, 40)}...`);
        }
      } else if (rpcs.destChain === chain) {
        // Force proper RPC for Unichain if it's using DRPC
        if (chain === 'Unichain' && rpcs.dest.includes('drpc.org')) {
          // Override with a better RPC for Unichain
          rpcUrl = process.env.UNICHAIN_RPC || 'https://mainnet.unichain.org';
          console.log(`[Bridge] Overriding Unichain RPC (was DRPC): ${rpcUrl.substring(0, 40)}...`);
        } else {
          rpcUrl = rpcs.dest;
          console.log(`[Bridge] Setting RPC for dest chain ${chain}: ${rpcUrl.substring(0, 40)}...`);
        }
      }
      // For other chains, we don't set an RPC (they won't be used in this transfer)

      if (rpcUrl) {
        config.chains[chain] = {
          rpc: rpcUrl
        };
      }
    }
    
    return config;
  }

  /**
   * Convert NTT_TOKENS to executor route config format
   */
  private buildExecutorConfig(): NttExecutorRoute.Config {
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
   * Fetch executor quote for NTT transfer
   */
  private async fetchExecutorQuote(
    sourceChain: Chain,
    destChain: Chain,
    amountStr: string
  ): Promise<NttWithExecutor.Quote> {
    const executorConfig = this.buildExecutorConfig();
    const executorRoute = nttExecutorRoute(executorConfig);
    // Cast wormhole to any to handle SDK version type mismatches
    const routeInstance = new executorRoute(this.wormhole as any);

    const srcTokenAddr = NTT_TOKENS[sourceChain]!.token;
    const dstTokenAddr = NTT_TOKENS[destChain]!.token;

    // Create transfer request
    const tr = await routes.RouteTransferRequest.create(this.wormhole, {
      source: Wormhole.tokenId(sourceChain, srcTokenAddr),
      destination: Wormhole.tokenId(destChain, dstTokenAddr),
    });

    // Validate parameters
    const validated = await routeInstance.validate(tr, { amount: amountStr });
    if (!validated.valid) {
      throw new Error(`Executor validation failed: ${validated.error?.message || 'Unknown error'}`);
    }

    // Get quote from executor
    const quote = await routeInstance.fetchExecutorQuote(tr, validated.params as NttExecutorRoute.ValidatedParams);

    console.log(`[Bridge] Executor quote received:`);
    console.log(`  Estimated cost: ${quote.estimatedCost.toString()} wei`);
    console.log(`  Expires: ${quote.expires.toISOString()}`);

    return quote;
  }

  async initiateTransfer(request: TransferRequest): Promise<TransferResult> {
    const transferId = this.generateTransferId();
    
    // Normalize chain names to match Wormhole SDK expectations
    const sourceChain = this.normalizeChainName(request.sourceChain);
    const destinationChain = this.normalizeChainName(request.destinationChain);
    
    // REQUIRE RPCs to be provided - no more fallbacks to rate-limited endpoints
    if (!request.sourceRpcUrl || !request.destRpcUrl) {
      const error = `[Bridge] ERROR: RPCs must be provided. Missing: ${!request.sourceRpcUrl ? 'sourceRpcUrl' : ''} ${!request.destRpcUrl ? 'destRpcUrl' : ''}`;
      console.error(error);
      throw new Error('RPCs must be provided by the caller. Use the RPC service to get healthy endpoints.');
    }

    // Force proper RPC for Unichain to avoid DRPC batch limits
    if (sourceChain === 'Unichain' && request.sourceRpcUrl.includes('drpc.org')) {
      request.sourceRpcUrl = process.env.UNICHAIN_RPC || 'https://mainnet.unichain.org';
      console.log('[Bridge] Forcing Unichain source RPC to avoid DRPC batch limits');
    }
    if (destinationChain === 'Unichain' && request.destRpcUrl.includes('drpc.org')) {
      request.destRpcUrl = process.env.UNICHAIN_RPC || 'https://mainnet.unichain.org';
      console.log('[Bridge] Forcing Unichain dest RPC to avoid DRPC batch limits');
    }
    
    console.log('[Bridge] Using provided RPCs:');
    console.log(`[Bridge]   Source (${sourceChain}): ${request.sourceRpcUrl.substring(0, 50)}...`);
    console.log(`[Bridge]   Dest (${destinationChain}): ${request.destRpcUrl.substring(0, 50)}...`);
    
    const customConfig = this.buildChainConfig({
      source: request.sourceRpcUrl,
      dest: request.destRpcUrl,
      sourceChain: sourceChain,
      destChain: destinationChain
    });
    
    this.wormhole = await wormhole("Mainnet", [evm], {
      chains: customConfig.chains
    });
    console.log('[Bridge] Wormhole initialized with provided RPCs');
    
    // Determine token (default to BRZ for backward compatibility)
    const token = request.token || 'BRZ';

    // Create transfer record
    const transfer: Transfer = {
      id: transferId,
      sourceChain: sourceChain,
      destinationChain: destinationChain,
      amount: request.amount,
      token: token,
      safeAddress: request.safeAddress,
      destinationAddress: request.destinationAddress || request.safeAddress,
      safeTxHashes: [],
      executedTxHashes: [],
      status: TransferStatus.PENDING_SAFE_APPROVAL,
      createdAt: new Date(),
      updatedAt: new Date()
    };

    this.transfers.set(transferId, transfer);

    try {
      // Get chain instances
      const src = this.wormhole.getChain(sourceChain);
      const dst = this.wormhole.getChain(destinationChain);

      const srcChainAddress = Wormhole.chainAddress(src.chain, request.safeAddress);
      const dstChainAddress = Wormhole.chainAddress(dst.chain, transfer.destinationAddress);

      console.log(`[Bridge] Initiating transfer of ${request.amount} ${token} from ${request.sourceChain} to ${request.destinationChain}`);

      // Collect transactions based on token type
      const transactions: any[] = [];

      if (token === 'BRZ') {
        // BRZ uses NTT protocol with Executor (new system replacing Standard Relayer)
        console.log(`[Bridge] Using NTT protocol with Executor for BRZ`);

        // Get both Ntt and NttWithExecutor protocols
        const srcNtt = await src.getProtocol("Ntt" as any, {
          ntt: NTT_TOKENS[src.chain],
        }) as any;

        const srcNttExecutor = await src.getProtocol("NttWithExecutor" as any, {
          ntt: NTT_TOKENS[src.chain],
        }) as any;

        const amt = amount.units(
          amount.parse(request.amount, await srcNtt.getTokenDecimals())
        );

        // Fetch executor quote (replaces quoteDeliveryPrice from Standard Relayer)
        console.log(`[Bridge] Fetching executor quote...`);
        const executorQuote = await this.fetchExecutorQuote(
          sourceChain,
          destinationChain,
          request.amount
        );

        // Create transfer generator using executor
        const xfer = () => srcNttExecutor.transfer(
          srcChainAddress.address,
          dstChainAddress,
          amt,
          executorQuote,
          srcNtt
        );

        // Collect NTT transactions
        const txGenerator = xfer();
        let step = await txGenerator.next();

        while (!step.done) {
          const transaction = step.value.transaction;
          transactions.push({
            to: transaction.to,
            value: transaction.value ? transaction.value.toString() : "0",
            data: transaction.data
          });

          console.log(`[Bridge] NTT Executor Transaction ${transactions.length}:`);
          console.log(`  To: ${transaction.to}`);
          console.log(`  Value: ${transaction.value || '0'}`);

          step = await txGenerator.next();
        }

      } else if (token === 'USDC' || token === 'USDT') {
        // USDC/USDT use CCTP protocol (Wormhole supports Base and Unichain)
        console.log(`[Bridge] Using CCTP protocol for ${token}`);

        // Get CCTP protocol instance
        const srcCctp = await src.getProtocol("AutomaticCircleBridge", {});

        // Parse amount (USDC/USDT have 6 decimals)
        const amt = BigInt(Math.floor(parseFloat(request.amount) * 1_000_000));

        console.log(`[Bridge] Amount in smallest units: ${amt.toString()}`);

        // Create Safe address for CCTP
        const safeEvmAddr = new EvmAddress(request.safeAddress) as any;
        const destEvmAddr = new EvmAddress(transfer.destinationAddress) as any;

        // Create transfer generator
        const xfer = () => srcCctp.transfer(
          safeEvmAddr,
          dstChainAddress as any,
          amt,
          0n // no native gas dropoff
        );

        // Collect CCTP transactions
        const txGenerator = xfer();
        let step = await txGenerator.next();

        while (!step.done) {
          const transaction = step.value.transaction;
          transactions.push({
            to: transaction.to,
            value: transaction.value ? transaction.value.toString() : "0",
            data: transaction.data
          });

          console.log(`[Bridge] CCTP Transaction ${transactions.length}:`);
          console.log(`  To: ${transaction.to}`);
          console.log(`  Value: ${transaction.value || '0'}`);

          step = await txGenerator.next();
        }
      } else {
        throw new Error(`Unsupported token: ${token}. Supported tokens: BRZ, USDC, USDT`);
      }

      console.log(`[Bridge] Total transactions to bundle: ${transactions.length}`);

      // Save initial transfer to database before attempting Safe transaction
      try {
        await this.dbService.saveTransfer(transfer);
        console.log('[Bridge] Initial transfer saved to database');
      } catch (dbError) {
        console.error('[Bridge] Error saving initial transfer to database:', dbError);
        // Don't fail the transfer if DB save fails
      }

      // Bundle and propose all transactions as one Safe transaction
      if (transactions.length > 0) {
        // Use custom RPC if provided, otherwise use the chain config
        const rpcUrl = request.sourceRpcUrl || src.config.rpc;
        console.log(`[Bridge] Using RPC for Safe transaction: ${rpcUrl.substring(0, 30)}...`);
        
        const result = await this.proposeBundledSafeTransaction(
          CHAIN_IDS[src.chain],
          request.safeAddress,
          transactions,
          this.signerWallet,
          rpcUrl
        );

        transfer.safeTxHashes.push(result.safeTxHash);
        
        
        if (result.executed && result.executionTxHash) {
          transfer.status = TransferStatus.EXECUTING;
          // Store the actual blockchain execution tx hash
          transfer.executedTxHashes.push(result.executionTxHash);
          console.log(`[Bridge] Transaction executed automatically`);
          console.log(`[Bridge] Execution tx hash: ${result.executionTxHash}`);
          
          // Start monitoring for completion
          this.monitorTransfer(transferId).catch(console.error);
        } else {
          transfer.status = TransferStatus.PENDING_SAFE_APPROVAL;
          console.log(`[Bridge] Transaction proposed, awaiting execution`);
        }

        console.log(`[Bridge] Safe tx hash: ${result.safeTxHash}`);
      }

      // Update transfer record
      transfer.updatedAt = new Date();
      this.transfers.set(transferId, transfer);

      // Update database with final status
      try {
        const executedTxHash = transfer.executedTxHashes && transfer.executedTxHashes.length > 0 
          ? transfer.executedTxHashes[0] 
          : undefined;
        await this.dbService.updateTransferStatus(transferId, transfer.status, undefined, executedTxHash);
        console.log('[Bridge] Transfer status updated in database');
      } catch (dbError) {
        console.error('[Bridge] Error updating transfer status in database:', dbError);
        // Don't fail the transfer if DB update fails
      }

      console.log(`[Bridge] Transfer initiated successfully`);
      console.log(`[Bridge] Transfer ID: ${transferId}`);
      console.log(`[Bridge] Safe TX Hashes: ${transfer.safeTxHashes.join(', ')}`);
      console.log(`[Bridge] Status: ${transfer.status}`);
      
      const message = transfer.status === TransferStatus.EXECUTING 
        ? 'Transaction bundled and executed automatically. Monitoring for completion...'
        : 'Transaction bundled and proposed to Safe. Please execute in the Safe UI.';
      
      console.log(`[Bridge] ${message}`);

      return {
        transferId,
        safeTxHashes: transfer.safeTxHashes,
        executedTxHashes: transfer.executedTxHashes,
        status: transfer.status,
        createdAt: transfer.createdAt,
        message
      };
    } catch (error: any) {
      // Detect specific RPC errors that should mark transactions as failed immediately
      let shouldMarkAsFailed = false;
      let errorReason = error.message;

      // Check for DRPC batch limit errors (similar to LiFi's bad request detection)
      if (error.message?.includes('Batch of more than') ||
          error.message?.includes('drpc.org') ||
          error.info?.error?.message?.includes('Batch of more than')) {
        shouldMarkAsFailed = true;
        errorReason = 'RPC Error: DRPC batch limit exceeded. Please use a different RPC for Unichain.';
        console.error('[Bridge] DRPC batch limit error detected - marking as failed');
      }

      // Check for other RPC-related errors
      if (error.code === 'SERVER_ERROR' ||
          error.code === 'NETWORK_ERROR' ||
          error.message?.includes('server response 500') ||
          error.message?.includes('server response 502') ||
          error.message?.includes('server response 503')) {
        shouldMarkAsFailed = true;
        errorReason = `RPC Error: ${error.code || 'Server error'}. The RPC endpoint is not responding properly.`;
        console.error('[Bridge] RPC server error detected - marking as failed');
      }

      // Check for insufficient funds or gas errors
      if (error.message?.includes('insufficient funds') ||
          error.message?.includes('gas required exceeds') ||
          error.code === 'INSUFFICIENT_FUNDS') {
        shouldMarkAsFailed = true;
        errorReason = 'Insufficient funds for gas';
        console.error('[Bridge] Insufficient funds error - marking as failed');
      }

      transfer.status = TransferStatus.FAILED;
      transfer.error = errorReason;
      transfer.updatedAt = new Date();
      this.transfers.set(transferId, transfer);

      // Save failed transfer to database
      try {
        await this.dbService.saveTransfer(transfer);
        console.log(`[Bridge] Failed transfer saved to database: ${errorReason}`);
      } catch (dbError) {
        console.error('[Bridge] Error saving failed transfer to database:', dbError);
      }

      throw error;
    }
  }

  private async monitorTransfer(transferId: string): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.executedTxHashes.length === 0) return;

    try {
      const lastTxHash = transfer.executedTxHashes[transfer.executedTxHashes.length - 1];
      
      console.log(`[Bridge] Monitoring transfer ${transferId}, tx: ${lastTxHash}`);
      
      // First check if the transaction was successful
      const { createProviderWithRetry } = await import('../utils/rpc-retry');
      const srcProvider = await createProviderWithRetry(
        this.wormhole.config.chains[transfer.sourceChain]?.rpc || '',
        3,
        2000
      );
      
      const receipt = await srcProvider.getTransactionReceipt(lastTxHash);
      
      if (!receipt || receipt.status !== 1) {
        console.log(`[Bridge] Transaction failed or not found`);
        transfer.status = TransferStatus.FAILED;
        transfer.error = 'Transaction failed';
        transfer.updatedAt = new Date();
        this.transfers.set(transferId, transfer);
        return;
      }
      
      console.log(`[Bridge] Transaction confirmed on source chain`);
      
      // Transaction is confirmed on source chain, but bridge is still processing
      // Wormhole takes time to complete the actual bridge
      transfer.status = TransferStatus.EXECUTING;
      console.log(`[Bridge] Transfer ${transferId} is now executing on Wormhole network`);
      console.log(`[Bridge] Waiting for Wormhole validators to complete the bridge...`);
      
      // Update database to EXECUTING status
      try {
        const executedTxHash = transfer.executedTxHashes && transfer.executedTxHashes.length > 0 
          ? transfer.executedTxHashes[0] 
          : undefined;
        await this.dbService.updateTransferStatus(transferId, TransferStatus.EXECUTING, undefined, executedTxHash);
      } catch (dbError) {
        console.error('[Bridge] Error updating transfer status in database:', dbError);
      }
      
    } catch (error: any) {
      console.error(`[Bridge] Error monitoring transfer ${transferId}:`, error);
      
      // If we can't verify, but know it was executed, mark as executing
      if (error.message.includes('could not be found')) {
        console.log(`[Bridge] Transaction not found, but was executed - marking as executing`);
        transfer.status = TransferStatus.EXECUTING;
        
        // Update database
        try {
          const executedTxHash = transfer.executedTxHashes && transfer.executedTxHashes.length > 0 
            ? transfer.executedTxHashes[0] 
            : undefined;
          await this.dbService.updateTransferStatus(transferId, TransferStatus.EXECUTING, undefined, executedTxHash);
        } catch (dbError) {
          console.error('[Bridge] Error updating transfer status in database:', dbError);
        }
      } else {
        transfer.status = TransferStatus.FAILED;
        transfer.error = error.message;
        
        // Update database
        try {
          await this.dbService.updateTransferStatus(transferId, TransferStatus.FAILED, error.message);
        } catch (dbError) {
          console.error('[Bridge] Error updating transfer status in database:', dbError);
        }
      }
    }

    transfer.updatedAt = new Date();
    this.transfers.set(transferId, transfer);
  }

  async resumeTransfer(txHash: string): Promise<any> {
    // Implementation for resuming stuck transfers
    // This would use the resume.ts logic from the original script
    try {
      console.log(`[Bridge] Attempting to resume transfer for tx: ${txHash}`);
      
      const status = await this.wormhole.getTransactionStatus(txHash, 25 * 60 * 1000);
      
      return {
        txHash,
        status,
        message: status ? 'Transfer completed' : 'Transfer still pending'
      };
    } catch (error: any) {
      throw new Error(`Failed to resume transfer: ${error.message}`);
    }
  }

  async getTransferStatus(transferId: string): Promise<Transfer | null> {
    const transfer = this.transfers.get(transferId);
    if (!transfer) return null;
    
    // If transfer is still executing, check Wormhole status
    if (transfer.status === TransferStatus.EXECUTING && transfer.executedTxHashes.length > 0) {
      const updated = await this.checkWormholeStatus(transfer);
      if (updated) {
        this.transfers.set(transferId, updated);
        return updated;
      }
    }
    
    return transfer;
  }
  
  private async checkWormholeStatus(transfer: Transfer): Promise<Transfer | null> {
    try {
      const txHash = transfer.executedTxHashes[0];
      console.log(`[Bridge] Checking Wormhole status for tx: ${txHash}`);
      
      // Check with Wormholescan API
      const axios = (await import('axios')).default;
      const response = await axios.get(
        `https://api.wormholescan.io/api/v1/operations?txHash=${txHash}`,
        {
          timeout: 10000,
          headers: {
            'Accept': 'application/json',
            'User-Agent': 'BRZ-Bridge-Service/1.0'
          }
        }
      );
      
      if (response.data && response.data.operations && response.data.operations.length > 0) {
        const operation = response.data.operations[0];
        
        // Check if target chain has completed
        if (operation.targetChain && operation.targetChain.status === 'completed') {
          console.log(`[Bridge] Wormhole transfer completed on destination chain`);
          transfer.status = TransferStatus.COMPLETED;
          transfer.completedAt = new Date();
          
          // Update database
          try {
            await this.dbService.updateTransferStatus(transfer.id, TransferStatus.COMPLETED, undefined, txHash);
          } catch (dbError) {
            console.error('[Bridge] Error updating transfer status in database:', dbError);
          }
          
          return transfer;
        } else if (operation.sourceChain && operation.sourceChain.status === 'confirmed') {
          // Source is confirmed but target not yet - still executing
          console.log(`[Bridge] Wormhole transfer still executing...`);
          return transfer;
        }
      }
    } catch (error: any) {
      console.error(`[Bridge] Error checking Wormhole status:`, error.message);
    }
    
    return null;
  }

  async getRecentTransfers(filters: {
    status?: string;
    sourceChain?: string;
    destinationChain?: string;
    limit: number;
  }): Promise<Transfer[]> {
    let transfers = Array.from(this.transfers.values());

    // Apply filters
    if (filters.status) {
      transfers = transfers.filter(t => t.status === filters.status);
    }
    if (filters.sourceChain) {
      transfers = transfers.filter(t => t.sourceChain === filters.sourceChain);
    }
    if (filters.destinationChain) {
      transfers = transfers.filter(t => t.destinationChain === filters.destinationChain);
    }

    // Sort by creation date (newest first) and limit
    return transfers
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filters.limit);
  }

  async getTransfersBySafe(safeAddress: string, limit: number): Promise<Transfer[]> {
    const transfers = Array.from(this.transfers.values())
      .filter(t => t.safeAddress.toLowerCase() === safeAddress.toLowerCase())
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);

    return transfers;
  }

  private async proposeSafeTransactionOnly(
    chainId: number,
    safeAddress: string,
    toAddress: string,
    value: string,
    callData: string,
    signerWallet: Wallet,
    rpcUrl: string
  ): Promise<string> {
    const { proposeTransactionOnly } = await import('../safe');
    return proposeTransactionOnly(
      chainId,
      safeAddress,
      toAddress,
      value,
      callData,
      signerWallet,
      rpcUrl
    );
  }

  private async proposeBundledSafeTransaction(
    chainId: number,
    safeAddress: string,
    transactions: Array<{to: string, value: string, data: string}>,
    signerWallet: Wallet,
    rpcUrl: string
  ): Promise<{safeTxHash: string, executed: boolean, executionTxHash?: string}> {
    const { proposeBundledTransaction } = await import('../safe');
    return proposeBundledTransaction(
      chainId,
      safeAddress,
      transactions,
      signerWallet,
      rpcUrl
    );
  }

  async getMetrics(): Promise<BridgeMetrics> {
    const transfers = Array.from(this.transfers.values());
    
    const metrics: BridgeMetrics = {
      totalTransfers: transfers.length,
      pendingTransfers: transfers.filter(t => 
        t.status === TransferStatus.PENDING_SAFE_APPROVAL || 
        t.status === TransferStatus.EXECUTING ||
        t.status === TransferStatus.WAITING_FOR_VAA
      ).length,
      completedTransfers: transfers.filter(t => t.status === TransferStatus.COMPLETED).length,
      failedTransfers: transfers.filter(t => t.status === TransferStatus.FAILED).length,
      totalVolumeByChain: {},
      averageTransferTime: 0
    };

    // Calculate volume by chain
    for (const transfer of transfers) {
      const chain = transfer.sourceChain;
      if (!metrics.totalVolumeByChain[chain]) {
        metrics.totalVolumeByChain[chain] = '0';
      }
      const currentVolume = parseFloat(metrics.totalVolumeByChain[chain]);
      const transferAmount = parseFloat(transfer.amount);
      metrics.totalVolumeByChain[chain] = (currentVolume + transferAmount).toString();
    }

    // Calculate average transfer time for completed transfers
    const completedTransfers = transfers.filter(t => 
      t.status === TransferStatus.COMPLETED && t.completedAt
    );
    
    if (completedTransfers.length > 0) {
      const totalTime = completedTransfers.reduce((sum, t) => {
        const duration = t.completedAt!.getTime() - t.createdAt.getTime();
        return sum + duration;
      }, 0);
      metrics.averageTransferTime = Math.round(totalTime / completedTransfers.length / 1000); // in seconds
    }

    return metrics;
  }

  /**
   * Get a CCTP quote for USDC/USDT transfer
   * Returns the relayer fee and expected amounts
   */
  async getCCTPQuote(
    sourceChain: string,
    destinationChain: string,
    token: 'USDC' | 'USDT',
    amount: string,
    sourceRpcUrl?: string,
    destRpcUrl?: string
  ): Promise<CCTPQuoteResult> {
    // Normalize chain names
    const srcChain = this.normalizeChainName(sourceChain);
    const dstChain = this.normalizeChainName(destinationChain);

    // Build config with RPCs if provided
    if (sourceRpcUrl && destRpcUrl) {
      const customConfig = this.buildChainConfig({
        source: sourceRpcUrl,
        dest: destRpcUrl,
        sourceChain: srcChain,
        destChain: dstChain
      });

      // Use wormhole() function instead of new Wormhole() to properly register CCTP
      this.wormhole = await wormhole("Mainnet", [evm], {
        chains: customConfig.chains
      });
    } else if (!this.wormhole) {
      // Initialize with defaults if not provided
      this.wormhole = await wormhole("Mainnet", [evm]);
    }

    const sendChain = this.wormhole.getChain(srcChain);
    const rcvChain = this.wormhole.getChain(dstChain);

    // Parse amount (USDC/USDT have 6 decimals)
    const amountBigInt = BigInt(Math.floor(parseFloat(amount) * 1_000_000));

    // Get quote from Wormhole CCTP
    // Type assertion needed due to SDK version incompatibilities
    const quote = await CircleTransfer.quoteTransfer(
      sendChain as any,
      rcvChain as any,
      {
        amount: amountBigInt,
        automatic: true,
        nativeGas: 0n
      }
    );

    // Convert to our format
    const relayFeeUSDC = quote.relayFee ? Number(quote.relayFee.amount) / 1_000_000 : 0;

    // Calculate actual fee from source vs destination difference
    const sourceAmount = Number(quote.sourceToken.amount) / 1_000_000;
    const destAmount = Number(quote.destinationToken.amount) / 1_000_000;
    const actualFeeFromDiff = sourceAmount - destAmount;

    console.log(`[CCTP Quote] Full quote details:`, JSON.stringify({
      sourceAmount: quote.sourceToken.amount.toString(),
      destAmount: quote.destinationToken.amount.toString(),
      relayFee: quote.relayFee ? quote.relayFee.amount.toString() : 'null',
      destinationNativeGas: quote.destinationNativeGas?.toString(),
      eta: quote.eta
    }, null, 2));
    console.log(`[CCTP Quote] SDK relay fee: $${relayFeeUSDC.toFixed(4)}`);
    console.log(`[CCTP Quote] Actual fee (source - dest): $${actualFeeFromDiff.toFixed(4)}`);
    console.log(`[CCTP Quote] Source: ${sourceAmount} USDC, Dest: ${destAmount} USDC`);

    // Use the actual difference as the real cost
    const realRelayFee = actualFeeFromDiff > 0 ? actualFeeFromDiff : relayFeeUSDC;

    return {
      sourceAmount: sourceAmount.toString(),
      destinationAmount: destAmount.toString(),
      relayFee: realRelayFee.toString(),
      relayFeeUSD: realRelayFee,
      destinationNativeGas: (quote.destinationNativeGas || 0n).toString(),
      eta: quote.eta || 10,
      expires: quote.expires?.toString() || new Date(Date.now() + 300000).toISOString()
    };
  }

  getSupportedChains(): string[] {
    return Object.keys(CHAIN_IDS);
  }

  private generateTransferId(): string {
    return `brz-transfer-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private normalizeChainName(chainName: string): Chain {
    // Map of lowercase chain names to Wormhole SDK expected names
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
  }
}