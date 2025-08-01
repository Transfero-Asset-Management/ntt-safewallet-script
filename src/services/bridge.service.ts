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

export class BridgeService {
  private wormhole: Wormhole<any>;
  private transfers: Map<string, Transfer> = new Map();
  private signerWallet: any; // Changed to any to handle both Wallet types

  constructor() {
    // Initialize Wormhole SDK
    this.wormhole = new Wormhole("Mainnet", [evm.Platform], {
      chains: this.buildChainConfig()
    });

    // Initialize signer wallet
    const privateKey = process.env.ETH_PRIVATE_KEY;
    if (!privateKey) {
      console.warn('ETH_PRIVATE_KEY not set - bridge service will not be able to propose transactions');
      this.signerWallet = Wallet.createRandom(); // Dummy wallet for read-only operations
    } else {
      this.signerWallet = new Wallet(privateKey);
    }
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
    
    // Create transfer record
    const transfer: Transfer = {
      id: transferId,
      sourceChain: request.sourceChain,
      destinationChain: request.destinationChain,
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
      const src = this.wormhole.getChain(request.sourceChain);
      const dst = this.wormhole.getChain(request.destinationChain);

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

      // Process all transactions
      const txGenerator = xfer();
      let step = await txGenerator.next();

      while (!step.done) {
        const transaction = step.value.transaction;
        
        console.log(`[Bridge] Proposing transaction to Safe...`);
        console.log(`To: ${transaction.to}`);
        console.log(`Value: ${transaction.value || '0'}`);

        const { safeTxHash, txHash } = await proposeTransaction(
          CHAIN_CONFIGS[src.chain]!.chainId,
          request.safeAddress,
          transaction.to,
          transaction.value ? transaction.value.toString() : "0",
          transaction.data,
          this.signerWallet,
          src.config.rpc
        );

        transfer.safeTxHashes.push(safeTxHash);
        if (txHash) {
          transfer.executedTxHashes.push(txHash);
          transfer.status = TransferStatus.EXECUTING;
        }

        console.log(`[Bridge] Safe tx proposed: ${safeTxHash}`);
        
        // Get next transaction
        step = await txGenerator.next();
      }

      // Update transfer record
      transfer.updatedAt = new Date();
      this.transfers.set(transferId, transfer);

      // If transactions were executed, monitor for completion
      if (transfer.executedTxHashes.length > 0) {
        this.monitorTransfer(transferId).catch(console.error);
      }

      return {
        transferId,
        safeTxHashes: transfer.safeTxHashes,
        executedTxHashes: transfer.executedTxHashes,
        status: transfer.status,
        createdAt: transfer.createdAt
      };
    } catch (error: any) {
      transfer.status = TransferStatus.FAILED;
      transfer.error = error.message;
      transfer.updatedAt = new Date();
      this.transfers.set(transferId, transfer);
      throw error;
    }
  }

  private async monitorTransfer(transferId: string): Promise<void> {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.executedTxHashes.length === 0) return;

    try {
      const lastTxHash = transfer.executedTxHashes[transfer.executedTxHashes.length - 1];
      
      console.log(`[Bridge] Monitoring transfer ${transferId}, tx: ${lastTxHash}`);
      
      // Wait for transaction status (up to 25 minutes)
      transfer.status = TransferStatus.WAITING_FOR_VAA;
      transfer.updatedAt = new Date();
      this.transfers.set(transferId, transfer);

      const status = await this.wormhole.getTransactionStatus(lastTxHash, 25 * 60 * 1000);
      
      if (status) {
        transfer.status = TransferStatus.COMPLETED;
        transfer.completedAt = new Date();
        console.log(`[Bridge] Transfer ${transferId} completed successfully`);
      } else {
        transfer.status = TransferStatus.READY_TO_REDEEM;
        console.log(`[Bridge] Transfer ${transferId} ready for redemption`);
      }
    } catch (error: any) {
      console.error(`[Bridge] Error monitoring transfer ${transferId}:`, error);
      transfer.status = TransferStatus.FAILED;
      transfer.error = error.message;
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
}