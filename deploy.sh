#!/bin/bash
# Deployment script for NTT Bridge Service
#
# This script is designed to run via cron (every minute) to auto-deploy code changes.
# It pulls from origin/brz-integration, builds, and restarts PM2 service when changes are detected.
#
# IMPORTANT: The script now includes fail-safe mechanisms:
# 1. Checks for local changes before pulling
# 2. Aborts deployment if git pull fails (prevents restart loops!)
# 3. Validates npm install and build steps
# 4. Only restarts service if ALL steps succeed
#
# Configuration:
# - Set AUTO_DISCARD_CHANGES=true in cron environment to auto-discard local changes
# - Without this flag, deployment will abort if local changes exist (safer default)
#
# Example cron with auto-discard:
#   * * * * * cd /path/to/project && AUTO_DISCARD_CHANGES=true ./deploy.sh
#
# Example cron without auto-discard (safer):
#   * * * * * cd /path/to/project && ./deploy.sh

echo "🚀 NTT Bridge Service Deployment Check..."

# Update remote refs
echo "🔍 Checking for updates..."
if ! git remote update 2>/dev/null; then
    echo "⚠️  Warning: Failed to update remote refs (network issue?)"
    echo "   Continuing with cached remote state..."
fi

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

    # Check for local changes that might prevent pull
    if ! git diff-files --quiet || ! git diff-index --quiet --cached HEAD --; then
        echo "⚠️  Local changes detected:"
        git status --short

        # Option to auto-discard local changes (controlled by environment variable)
        if [ "${AUTO_DISCARD_CHANGES}" = "true" ]; then
            echo "🔄 AUTO_DISCARD_CHANGES=true: Discarding local changes..."
            git reset --hard HEAD
            git clean -fd
            echo "✅ Local changes discarded. Proceeding with pull..."
        else
            echo "❌ Cannot pull with local changes present."
            echo "   Options:"
            echo "   1. Set AUTO_DISCARD_CHANGES=true in environment to auto-discard"
            echo "   2. Manually run: git reset --hard HEAD && git clean -fd"
            echo "   3. Commit/push local changes first"
            echo ""
            echo "⏸️  Deployment aborted. Service NOT restarted."
            exit 1
        fi
    fi

    # Store if .env exists before pull
    ENV_BEFORE=""
    if [ -f .env ]; then
        ENV_BEFORE=$(cat .env | md5sum)
    fi

    # Pull latest code with error checking
    echo "📥 Pulling latest code from origin/brz-integration..."
    if ! git pull origin brz-integration; then
        echo "❌ Git pull failed!"
        echo "   Possible causes:"
        echo "   - Network issues"
        echo "   - Merge conflicts"
        echo "   - Remote repository unavailable"
        echo ""
        echo "⏸️  Deployment aborted. Service NOT restarted."
        exit 1
    fi

    echo "✅ Git pull successful"

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
        if ! npm install; then
            echo "❌ npm install failed!"
            echo "⏸️  Deployment aborted. Service NOT restarted."
            exit 1
        fi
        echo "✅ Dependencies installed successfully"
    fi

    # Build the project
    echo "🔨 Building project..."
    if ! npm run build; then
        echo "❌ Build failed!"
        echo "⏸️  Deployment aborted. Service NOT restarted."
        exit 1
    fi

    echo "✅ Build successful"
    
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