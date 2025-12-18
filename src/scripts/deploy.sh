#!/bin/bash

# Server-side deployment script
# Manual helper to deploy a service and regenerate configs
# Uses generate-all.js to scan ~/.factiii/*/factiii.yml and regenerate merged configs

set -e

REPO_NAME="$1"
ENVIRONMENT="$2"

if [ -z "$REPO_NAME" ] || [ -z "$ENVIRONMENT" ]; then
    echo "Usage: $0 <repo-name> <environment>"
    echo "Example: $0 factiii staging"
    exit 1
fi

FACTIII_DIR="${FACTIII_DIR:-$HOME/.factiii}"
REPO_DIR="${FACTIII_DIR}/${REPO_NAME}"
SERVICE_KEY="${REPO_NAME}-${ENVIRONMENT}"
GENERATE_SCRIPT="${FACTIII_DIR}/scripts/generate-all.js"

echo "🚀 Deploying ${SERVICE_KEY}..."
echo "   Factiii directory: ${FACTIII_DIR}"
echo "   Repo directory: ${REPO_DIR}"

# Check repo exists
if [ ! -d "$REPO_DIR" ]; then
    echo "❌ Repo directory not found: ${REPO_DIR}"
    echo "   Clone the repo first: git clone <repo-url> ${REPO_DIR}"
    exit 1
fi

# Check factiii.yml exists
if [ ! -f "${REPO_DIR}/factiii.yml" ]; then
    echo "❌ factiii.yml not found in ${REPO_DIR}"
    exit 1
fi

# Regenerate docker-compose and nginx using generate-all.js
echo "🔄 Regenerating configurations..."
if [ -f "$GENERATE_SCRIPT" ]; then
    node "$GENERATE_SCRIPT" || {
        echo "⚠️  Config regeneration failed, but continuing with deployment..."
    }
else
    echo "⚠️  generate-all.js not found at ${GENERATE_SCRIPT}"
    echo "   Copy it from the package: cp /path/to/infrastructure/src/scripts/generate-all.js ${GENERATE_SCRIPT}"
fi

# Check if docker-compose.yml exists
COMPOSE_FILE="${FACTIII_DIR}/docker-compose.yml"
if [ ! -f "$COMPOSE_FILE" ]; then
    echo "❌ docker-compose.yml not found. Run generate-all.js first."
    exit 1
fi

# Pull and restart service
if command -v docker &> /dev/null; then
    echo "🐳 Building/pulling and starting ${SERVICE_KEY}..."
    cd "$FACTIII_DIR"
    
    docker compose -f "$COMPOSE_FILE" up -d --build "$SERVICE_KEY" || {
        echo "❌ Failed to start service"
        exit 1
    }
    
    echo "✅ Service ${SERVICE_KEY} started"
    
    # Show status
    echo ""
    echo "📊 Service status:"
    docker compose -f "$COMPOSE_FILE" ps "$SERVICE_KEY"
else
    echo "⚠️  Docker not found. Skipping container operations."
fi

echo ""
echo "✅ Deployment complete for ${SERVICE_KEY}"


