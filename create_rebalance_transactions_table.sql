-- Create rebalance_transactions table for NTT bridge transfers
CREATE TABLE IF NOT EXISTS rebalance_transactions (
    id SERIAL PRIMARY KEY,
    transaction_hash VARCHAR(255) NOT NULL,
    bridge_provider VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL,
    from_network VARCHAR(50) NOT NULL,
    from_safe_address VARCHAR(255) NOT NULL,
    from_token_symbol VARCHAR(10) NOT NULL,
    from_token_address VARCHAR(255) NOT NULL,
    from_amount DECIMAL(36, 18) NOT NULL,
    to_network VARCHAR(50) NOT NULL,
    to_safe_address VARCHAR(255) NOT NULL,
    to_token_symbol VARCHAR(10) NOT NULL,
    to_token_address VARCHAR(255) NOT NULL,
    to_amount DECIMAL(36, 18),
    from_amount_usd DECIMAL(20, 6),
    to_amount_usd DECIMAL(20, 6),
    bridge_fee_usd DECIMAL(20, 6),
    gas_fee_usd DECIMAL(20, 6),
    total_fee_usd DECIMAL(20, 6),
    bridge_route_data JSONB,
    bridge_transaction_id VARCHAR(255),
    reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    completion_time INTERVAL GENERATED ALWAYS AS (
        CASE 
            WHEN completed_at IS NOT NULL 
            THEN completed_at - created_at 
            ELSE NULL 
        END
    ) STORED,
    UNIQUE(transaction_hash, bridge_provider)
);

-- Create indexes for better query performance
CREATE INDEX idx_rebalance_transactions_status ON rebalance_transactions(status);
CREATE INDEX idx_rebalance_transactions_created_at ON rebalance_transactions(created_at DESC);
CREATE INDEX idx_rebalance_transactions_bridge_provider ON rebalance_transactions(bridge_provider);
CREATE INDEX idx_rebalance_transactions_networks ON rebalance_transactions(from_network, to_network);
CREATE INDEX idx_rebalance_transactions_bridge_transaction_id ON rebalance_transactions(bridge_transaction_id);

-- Add trigger to automatically update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_rebalance_transactions_updated_at
BEFORE UPDATE ON rebalance_transactions
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();