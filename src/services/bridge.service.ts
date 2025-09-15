import { Wormhole, amount, Chain } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import { Wallet } from "ethers";
import "@wormhole-foundation/sdk-evm-ntt";

import { NTT_TOKENS, CHAIN_IDS } from "../utils/const";
import { proposeTransaction } from "../safe";
import { 
  TransferRequest, 
  TransferResult, 
  TransferStatus, 
  Transfer,
  BridgeMetrics 
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
        rpcUrl = rpcs.source;
        console.log(`[Bridge] Setting RPC for source chain ${chain}: ${rpcUrl.substring(0, 40)}...`);
      } else if (rpcs.destChain === chain) {
        rpcUrl = rpcs.dest;
        console.log(`[Bridge] Setting RPC for dest chain ${chain}: ${rpcUrl.substring(0, 40)}...`);
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
    
    console.log('[Bridge] Using provided RPCs:');
    console.log(`[Bridge]   Source (${sourceChain}): ${request.sourceRpcUrl.substring(0, 50)}...`);
    console.log(`[Bridge]   Dest (${destinationChain}): ${request.destRpcUrl.substring(0, 50)}...`);
    
    const customConfig = this.buildChainConfig({
      source: request.sourceRpcUrl,
      dest: request.destRpcUrl,
      sourceChain: sourceChain,
      destChain: destinationChain
    });
    
    this.wormhole = new Wormhole("Mainnet", [evm.Platform], {
      chains: customConfig.chains
    });
    console.log('[Bridge] Wormhole initialized with provided RPCs');
    
    // Create transfer record
    const transfer: Transfer = {
      id: transferId,
      sourceChain: sourceChain,
      destinationChain: destinationChain,
      amount: request.amount,
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

      // Get NTT protocol instance
      const srcNtt = await src.getProtocol("Ntt", {
        ntt: NTT_TOKENS[src.chain],
      });

      // Parse amount
      const amt = amount.units(
        amount.parse(request.amount, await srcNtt.getTokenDecimals())
      );

      console.log(`[Bridge] Initiating transfer of ${request.amount} BRZ from ${request.sourceChain} to ${request.destinationChain}`);

      // Create transfer generator
      const xfer = () => srcNtt.transfer(srcChainAddress.address, amt, dstChainAddress, {
        queue: false,
        automatic: true,
        gasDropoff: 0n,
      });

      // Collect all transactions first
      const transactions: any[] = [];
      const txGenerator = xfer();
      let step = await txGenerator.next();

      while (!step.done) {
        const transaction = step.value.transaction;
        transactions.push({
          to: transaction.to,
          value: transaction.value ? transaction.value.toString() : "0",
          data: transaction.data
        });
        
        console.log(`[Bridge] Transaction ${transactions.length}:`);
        console.log(`  To: ${transaction.to}`);
        console.log(`  Value: ${transaction.value || '0'}`);
        
        // Get next transaction
        step = await txGenerator.next();
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
      transfer.status = TransferStatus.FAILED;
      transfer.error = error.message;
      transfer.updatedAt = new Date();
      this.transfers.set(transferId, transfer);
      
      // Save failed transfer to database
      try {
        await this.dbService.saveTransfer(transfer);
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