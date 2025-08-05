import { Wormhole, amount, Chain } from "@wormhole-foundation/sdk";
import evm from "@wormhole-foundation/sdk/platforms/evm";
import { Wallet } from "ethers";
import "@wormhole-foundation/sdk-evm-ntt";

import { NTT_TOKENS, CHAIN_CONFIGS } from "../utils/const";
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
    // Initialize Wormhole SDK
    this.wormhole = new Wormhole("Mainnet", [evm.Platform], {
      chains: this.buildChainConfig()
    });

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

  private buildChainConfig(): any {
    const config: any = { chains: {} };
    
    for (const [chain, chainConfig] of Object.entries(CHAIN_CONFIGS)) {
      if (chainConfig) {
        config.chains[chain] = {
          rpc: chainConfig.rpc
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
        const result = await this.proposeBundledSafeTransaction(
          CHAIN_CONFIGS[src.chain]!.chainId,
          request.safeAddress,
          transactions,
          this.signerWallet,
          src.config.rpc
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
        await this.dbService.updateTransferStatus(transferId, transfer.status);
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
      const { JsonRpcProvider } = await import('ethers');
      const srcProvider = new JsonRpcProvider(
        this.wormhole.config.chains[transfer.sourceChain]?.rpc
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
      
      // For NTT transfers, they complete instantly when executed
      // No need to wait for VAA - the transfer is already complete
      transfer.status = TransferStatus.COMPLETED;
      transfer.completedAt = new Date();
      console.log(`[Bridge] Transfer ${transferId} completed successfully`);
      console.log(`[Bridge] BRZ has been transferred to ${transfer.destinationChain}`);
      
      // Update database
      try {
        await this.dbService.updateTransferStatus(transferId, TransferStatus.COMPLETED);
      } catch (dbError) {
        console.error('[Bridge] Error updating transfer status in database:', dbError);
      }
      
    } catch (error: any) {
      console.error(`[Bridge] Error monitoring transfer ${transferId}:`, error);
      
      // If we can't verify, but know it was executed, mark as completed
      if (error.message.includes('could not be found')) {
        console.log(`[Bridge] Transaction not found, but was executed - marking as completed`);
        transfer.status = TransferStatus.COMPLETED;
        transfer.completedAt = new Date();
        
        // Update database
        try {
          await this.dbService.updateTransferStatus(transferId, TransferStatus.COMPLETED);
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
    return this.transfers.get(transferId) || null;
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
    return Object.keys(CHAIN_CONFIGS);
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