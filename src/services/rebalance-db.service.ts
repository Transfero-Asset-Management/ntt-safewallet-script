import { Pool } from 'pg';
import { Transfer, TransferStatus } from '../types/bridge.types';

export class RebalanceDbService {
  private db: Pool;

  constructor() {
    // Initialize database connection
    const databaseUrl = process.env.DATABASE_URL || 'postgresql://arb_user:arb_password@localhost:5432/pricing_service_db';
    console.log('[RebalanceDB] Initializing with database URL:', databaseUrl.replace(/\/\/.*@/, '//<credentials>@'));
    this.db = new Pool({ connectionString: databaseUrl });
    
    // Test connection
    this.db.query('SELECT NOW()', (err: Error | null, res: any) => {
      if (err) {
        console.error('[RebalanceDB] Failed to connect to database:', err.message);
      } else {
        console.log('[RebalanceDB] Successfully connected to database at', res.rows[0].now);
      }
    });
  }

  /**
   * Save NTT bridge transfer to rebalance_transactions table
   */
  async saveTransfer(transfer: Transfer): Promise<number> {
    console.log(`[RebalanceDB] Attempting to save transfer ${transfer.id}`);
    console.log(`[RebalanceDB] Transfer details:`, {
      id: transfer.id,
      sourceChain: transfer.sourceChain,
      destinationChain: transfer.destinationChain,
      amount: transfer.amount,
      status: transfer.status,
      txHashes: transfer.executedTxHashes
    });
    
    try {
      // Map transfer status to rebalance transaction status
      let dbStatus = 'pending';
      if (transfer.status === TransferStatus.COMPLETED) {
        dbStatus = 'completed';
      } else if (transfer.status === TransferStatus.FAILED) {
        dbStatus = 'failed';
      } else if (transfer.status === TransferStatus.EXECUTING || 
                 transfer.status === TransferStatus.WAITING_FOR_VAA) {
        dbStatus = 'processing';
      }

      // Use the execution transaction hash as the main transaction hash, fallback to id for pending
      const txHash = transfer.executedTxHashes && transfer.executedTxHashes.length > 0 
        ? transfer.executedTxHashes[0] 
        : transfer.id;

      // Calculate USD values (BRZ approximate rate)
      const BRZ_USD_RATE = 0.20;
      const amountFloat = parseFloat(transfer.amount);
      const amountUsd = amountFloat * BRZ_USD_RATE;
      
      // Estimate fees (these are rough estimates for NTT)
      const estimatedBridgeFeeUsd = 5; // Typical NTT bridge fee
      const estimatedGasFeeUsd = 2; // Typical gas fee
      const totalFeeUsd = estimatedBridgeFeeUsd + estimatedGasFeeUsd;

      const query = `
        INSERT INTO rebalance_transactions (
          transaction_hash,
          bridge_provider,
          status,
          from_network,
          from_safe_address,
          from_token_symbol,
          from_token_address,
          from_amount,
          from_amount_usd,
          to_network,
          to_safe_address,
          to_token_symbol,
          to_token_address,
          to_amount,
          to_amount_usd,
          bridge_fee_usd,
          gas_fee_usd,
          total_fee_usd,
          created_at,
          completed_at,
          bridge_transaction_id,
          reason
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
        )
        ON CONFLICT (transaction_hash, bridge_provider) 
        DO UPDATE SET 
          status = EXCLUDED.status,
          completed_at = EXCLUDED.completed_at,
          reason = EXCLUDED.reason,
          from_amount_usd = EXCLUDED.from_amount_usd,
          to_amount_usd = EXCLUDED.to_amount_usd,
          bridge_fee_usd = EXCLUDED.bridge_fee_usd,
          gas_fee_usd = EXCLUDED.gas_fee_usd,
          total_fee_usd = EXCLUDED.total_fee_usd,
          updated_at = CURRENT_TIMESTAMP
        RETURNING id
      `;

      // Get BRZ token addresses for each network
      const tokenAddresses = this.getTokenAddresses(transfer.sourceChain, transfer.destinationChain);

      const values = [
        txHash,                              // transaction_hash
        'wormhole',                          // bridge_provider (NTT uses Wormhole)
        dbStatus,                            // status
        transfer.sourceChain,                // from_network
        transfer.safeAddress,                // from_safe_address
        'BRZ',                              // from_token_symbol
        tokenAddresses.source,               // from_token_address
        transfer.amount,                     // from_amount
        amountUsd,                           // from_amount_usd
        transfer.destinationChain,           // to_network
        transfer.destinationAddress,         // to_safe_address
        'BRZ',                              // to_token_symbol
        tokenAddresses.destination,          // to_token_address
        transfer.amount,                     // to_amount (same as from_amount for BRZ)
        amountUsd,                           // to_amount_usd
        estimatedBridgeFeeUsd,               // bridge_fee_usd
        estimatedGasFeeUsd,                  // gas_fee_usd
        totalFeeUsd,                         // total_fee_usd
        transfer.createdAt,                  // created_at
        transfer.completedAt || null,        // completed_at
        transfer.id,                         // bridge_transaction_id
        transfer.error ? `Error: ${transfer.error}` : `Safe TX: ${transfer.safeTxHashes.join(', ')}`  // reason
      ];

      const result = await this.db.query(query, values);
      console.log(`[RebalanceDB] Saved NTT transfer ${transfer.id} to database with ID ${result.rows[0].id}`);
      
      return result.rows[0].id;
    } catch (error) {
      console.error('[RebalanceDB] Error saving transfer to database:', error);
      throw error;
    }
  }

  /**
   * Update transfer status in database
   */
  async updateTransferStatus(transferId: string, status: TransferStatus, error?: string, executedTxHash?: string): Promise<void> {
    try {
      let dbStatus = 'pending';
      if (status === TransferStatus.COMPLETED) {
        dbStatus = 'completed';
      } else if (status === TransferStatus.FAILED) {
        dbStatus = 'failed';
      } else if (status === TransferStatus.EXECUTING || 
                 status === TransferStatus.WAITING_FOR_VAA) {
        dbStatus = 'processing';
      }

      // Update transaction_hash if we now have the executed tx hash
      const query = executedTxHash ? `
        UPDATE rebalance_transactions 
        SET 
          status = $1::varchar,
          reason = $2,
          transaction_hash = $3,
          completed_at = CASE WHEN $1 = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END,
          updated_at = CURRENT_TIMESTAMP
        WHERE bridge_transaction_id = $4
      ` : `
        UPDATE rebalance_transactions 
        SET 
          status = $1::varchar,
          reason = $2,
          completed_at = CASE WHEN $1 = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END,
          updated_at = CURRENT_TIMESTAMP
        WHERE bridge_transaction_id = $3
      `;

      const params = executedTxHash 
        ? [dbStatus, error || null, executedTxHash, transferId]
        : [dbStatus, error || null, transferId];

      await this.db.query(query, params);
      console.log(`[RebalanceDB] Updated transfer ${transferId} status to ${dbStatus}${executedTxHash ? ` with tx hash ${executedTxHash}` : ''}`);
    } catch (error) {
      console.error('[RebalanceDB] Error updating transfer status:', error);
      // Don't throw - we don't want to break the transfer flow if DB update fails
    }
  }

  /**
   * Get BRZ token addresses for source and destination chains
   */
  private getTokenAddresses(sourceChain: string, destinationChain: string): { source: string; destination: string } {
    const addresses: { [key: string]: string } = {
      'Arbitrum': '0xa8940698fda5a07abaef4a5ccdf2f1bb525b47a2',
      'Avalanche': '0x05539f021b66fd01d1fb1ff8e167cdd09bf7c2d0',
      'Base': '0xe9185ee218cae427af7b9764a011bb89fea761b4',
      'BSC': '0x0295afd3D7E86068050d64509e515f2Db71b4914',
      'Polygon': '0x4ed141110f6eeeaba9a1df36d8c26f684d2475dc',
      'Unichain': '0x0000000000000000000000000000000000000000' // Update when available
    };

    return {
      source: addresses[sourceChain] || '0x0000000000000000000000000000000000000000',
      destination: addresses[destinationChain] || '0x0000000000000000000000000000000000000000'
    };
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    await this.db.end();
  }
}