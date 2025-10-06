import { Chain } from "@wormhole-foundation/sdk";

export interface TransferRequest {
  sourceChain: Chain;
  destinationChain: Chain;
  amount: string;
  token?: 'BRZ' | 'USDC' | 'USDT';  // Token to bridge (default: BRZ)
  safeAddress: string;
  destinationAddress?: string;
  sourceRpcUrl?: string;  // Optional RPC URL for source chain
  destRpcUrl?: string;    // Optional RPC URL for destination chain
}

export interface TransferResult {
  transferId: string;
  safeTxHashes: string[];
  executedTxHashes: string[];
  status: TransferStatus;
  createdAt: Date;
  message?: string;
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
  token: 'BRZ' | 'USDC' | 'USDT';  // Token being bridged
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

export interface CCTPQuoteResult {
  sourceAmount: string;       // Amount to send
  destinationAmount: string;   // Amount to receive
  relayFee: string;           // Relay fee in source token
  relayFeeUSD: number;        // Relay fee in USD
  destinationNativeGas: string; // Native gas dropoff
  eta: number;                 // Estimated time in minutes
  expires: string;             // Quote expiration time
}