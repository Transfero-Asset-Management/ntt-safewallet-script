#!/bin/bash
# Deployment script for NTT Bridge Service

echo "🚀 NTT Bridge Service Deployment Check..."

# Update remote refs
echo "🔍 Checking for updates..."
git remote update

# Check git status
UPSTREAM='origin/brz-integration'
LOCAL=$(git rev-parse @)
REMOTE=$(git rev-parse "$UPSTREAM")
BASE=$(git merge-base @ "$UPSTREAM")

if [ $LOCAL = $REMOTE ]; then
    echo "✅ Already up-to-date. No deployment needed."
    pm2 status brz-ntt-bridge
    exit 0
elif [ $LOCAL = $BASE ]; then
    echo "📥 Updates available. Deploying..."
    
    # Store if .env exists before pull
    ENV_BEFORE=""
    if [ -f .env ]; then
        ENV_BEFORE=$(cat .env | md5sum)
    fi
    
    # Pull latest code
    git pull origin brz-integration
    
    # Check if .env changed
    ENV_AFTER=""
    ENV_CHANGED=false
    if [ -f .env ]; then
        ENV_AFTER=$(cat .env | md5sum)
        if [ "$ENV_BEFORE" != "$ENV_AFTER" ]; then
            ENV_CHANGED=true
        fi
    fi
    
    # Check if package.json changed
    if git diff HEAD~1 HEAD --name-only | grep -q "package.json"; then
        echo "📦 Dependencies changed, installing..."
        npm install
    fi
    
    # Build the project
    echo "🔨 Building project..."
    npm run build
    
    # Restart with appropriate method
    echo "♻️  Restarting service..."
    if pm2 list | grep -q "brz-ntt-bridge"; then
        if [ "$ENV_CHANGED" = true ]; then
            echo "📝 .env file changed, updating environment..."
            pm2 restart brz-ntt-bridge --update-env
        else
            # Zero downtime reload
            pm2 reload brz-ntt-bridge
        fi
    else
        # First time start
        echo "🆕 Starting service for the first time..."
        pm2 start ecosystem.config.js
    fi
    
    # Show logs
    echo "📋 Recent logs:"
    pm2 logs brz-ntt-bridge --lines 20 --nostream
    
    echo "✅ Deployment complete!"
    
elif [ $REMOTE = $BASE ]; then
    echo "⚠️  Local changes need to be pushed to remote."
    echo "   Run: git push origin brz-integration"
    exit 1
else
    echo "❌ Branches have diverged. Manual intervention required."
    echo "   You may need to merge or rebase."
    exit 1
fi