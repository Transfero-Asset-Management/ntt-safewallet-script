#!/bin/bash

# Database migration script for production
# Run this on your production server to create the rebalance_transactions table

# Check if DATABASE_URL is provided as argument or environment variable
if [ -n "$1" ]; then
    DATABASE_URL="$1"
elif [ -z "$DATABASE_URL" ]; then
    echo "Error: DATABASE_URL not provided"
    echo "Usage: ./run_db_migration.sh 'postgresql://user:password@host:port/dbname'"
    echo "Or set DATABASE_URL environment variable"
    exit 1
fi

echo "Running database migration..."
echo "Database URL: ${DATABASE_URL//:*@/:***@}"

# Run the SQL file
psql "$DATABASE_URL" < create_rebalance_transactions_table.sql

if [ $? -eq 0 ]; then
    echo "✅ Migration completed successfully!"
else
    echo "❌ Migration failed!"
    exit 1
fi