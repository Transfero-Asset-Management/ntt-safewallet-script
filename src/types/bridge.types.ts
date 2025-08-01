import { Chain } from "@wormhole-foundation/sdk";

export interface TransferRequest {
  sourceChain: Chain;
  destinationChain: Chain;
  amount: string;
  safeAddress: string;
  destinationAddress?: string;
}

export interface TransferResult {
  transferId: string;
  safeTxHashes: string[];
  executedTxHashes: string[];
  status: TransferStatus;
  createdAt: Date;
}

export enum TransferStatus {
  PENDING_SAFE_APPROVAL = 'pending_safe_approval',
  EXECUTING = 'executing',
  WAITING_FOR_VAA = 'waiting_for_vaa',
  READY_TO_REDEEM = 'ready_to_redeem',
  COMPLETED = 'completed',
  FAILED = 'failed'
}

export interface Transfer {
  id: string;
  sourceChain: Chain;
  destinationChain: Chain;
  amount: string;
  safeAddress: string;
  destinationAddress: string;
  safeTxHashes: string[];
  executedTxHashes: string[];
  vaa?: string;
  status: TransferStatus;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

export interface BridgeMetrics {
  totalTransfers: number;
  pendingTransfers: number;
  completedTransfers: number;
  failedTransfers: number;
  totalVolumeByChain: Record<string, string>;
  averageTransferTime: number;
}