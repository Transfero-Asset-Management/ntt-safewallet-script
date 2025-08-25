import { Pool } from 'pg';
import { Transfer, TransferStatus } from '../types/bridge.types';

/**
 * Database service for rebalance transactions
 * NOTE: This service no longer saves transfers directly.
 * All database operations are handled by the main API's unified rebalance service.
 */
export class RebalanceDbService {
  private db: Pool;

  constructor() {
    // Initialize database connection (kept for potential future use)
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
   * @deprecated Database saving is now handled by the main API's unified rebalance service
   * This method only logs the transfer details and returns a dummy ID
   */
  async saveTransfer(transfer: Transfer): Promise<number> {
    console.log(`[RebalanceDB] SKIPPING database save - handled by main API`);
    console.log(`[RebalanceDB] Transfer details:`, {
      id: transfer.id,
      sourceChain: transfer.sourceChain,
      destinationChain: transfer.destinationChain,
      amount: transfer.amount,
      status: transfer.status,
      txHashes: transfer.executedTxHashes
    });
    
    // Return dummy ID - the main API will assign the real database ID
    return 999999;
  }

  /**
   * @deprecated Status updates are now handled by the main API's unified rebalance service
   */
  async updateTransferStatus(
    transferId: string, 
    status: TransferStatus, 
    completedAt?: Date,
    executedTxHash?: string
  ): Promise<void> {
    console.log(`[RebalanceDB] SKIPPING status update - handled by main API`);
    console.log(`[RebalanceDB] Transfer ${transferId} status: ${status}`);
    
    // No-op - the main API handles all database updates
  }

  /**
   * Get transfer by ID (kept for potential future use)
   */
  async getTransferById(transferId: string): Promise<any> {
    try {
      const query = `
        SELECT * FROM rebalance_transactions 
        WHERE bridge_transaction_id = $1 
        OR transaction_hash = $1
        LIMIT 1
      `;
      const result = await this.db.query(query, [transferId]);
      return result.rows[0];
    } catch (error) {
      console.error('[RebalanceDB] Error getting transfer:', error);
      return null;
    }
  }

  /**
   * Close database connection
   */
  async close(): Promise<void> {
    await this.db.end();
  }
}