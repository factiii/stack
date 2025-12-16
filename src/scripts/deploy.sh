#!/bin/bash

# Server-side deployment script
# Updates a specific service config and restarts it

set -e

REPO_NAME="$1"
ENVIRONMENT="$2"
CONFIG_FILE="$3"

if [ -z "$REPO_NAME" ] || [ -z "$ENVIRONMENT" ]; then
    echo "Usage: $0 <repo-name> <environment> [config-file]"
    echo "Example: $0 factiii staging /path/to/factiii.yml"
    exit 1
fi

INFRA_DIR="${INFRA_DIR:-$HOME/infrastructure}"
CONFIGS_DIR="${INFRA_DIR}/configs"
SERVICE_KEY="${REPO_NAME}-${ENVIRONMENT}"

echo "🚀 Deploying ${SERVICE_KEY}..."
echo "   Infrastructure directory: ${INFRA_DIR}"

# Ensure configs directory exists
mkdir -p "$CONFIGS_DIR"

# If config file provided, copy it
if [ -n "$CONFIG_FILE" ] && [ -f "$CONFIG_FILE" ]; then
    echo "📝 Updating config file..."
    cp "$CONFIG_FILE" "${CONFIGS_DIR}/${REPO_NAME}.yml"
    echo "✅ Updated: ${CONFIGS_DIR}/${REPO_NAME}.yml"
fi

# Regenerate docker-compose and nginx
echo "🔄 Regenerating configurations..."
"${INFRA_DIR}/scripts/check-config.sh" || {
    echo "⚠️  Config regeneration failed, but continuing with deployment..."
}

# Check if docker-compose.yml exists
COMPOSE_FILE="${INFRA_DIR}/docker-compose.yml"
if [ ! -f "$COMPOSE_FILE" ]; then
    echo "❌ docker-compose.yml not found. Run check-config.sh first."
    exit 1
fi

# Pull latest image
echo "📥 Pulling latest image for ${SERVICE_KEY}..."
cd "$INFRA_DIR"

# Extract ECR info from config if available
if [ -f "${CONFIGS_DIR}/${REPO_NAME}.yml" ]; then
    # Try to get ECR info (simplified - in production use yq or similar)
    ECR_REGISTRY=$(grep -E "^ecr_registry:" "${CONFIGS_DIR}/${REPO_NAME}.yml" | cut -d: -f2 | tr -d ' ' || echo "")
    ECR_REPOSITORY=$(grep -E "^ecr_repository:" "${CONFIGS_DIR}/${REPO_NAME}.yml" | cut -d: -f2 | tr -d ' ' || echo "apps")
    
    if [ -n "$ECR_REGISTRY" ] && command -v aws &> /dev/null; then
        echo "🔐 Logging into ECR..."
        AWS_REGION=$(echo "$ECR_REGISTRY" | sed -E 's/.*\.dkr\.ecr\.([^.]+)\.amazonaws\.com.*/\1/')
        aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY" || {
            echo "⚠️  ECR login failed. Continuing without pull..."
        }
    fi
fi

# Pull and restart service
if command -v docker &> /dev/null && command -v docker-compose &> /dev/null; then
    echo "🐳 Pulling and restarting ${SERVICE_KEY}..."
    docker compose -f "$COMPOSE_FILE" pull "$SERVICE_KEY" || {
        echo "⚠️  Failed to pull image. Continuing with restart..."
    }
    
    docker compose -f "$COMPOSE_FILE" up -d "$SERVICE_KEY" || {
        echo "❌ Failed to start service"
        exit 1
    }
    
    echo "✅ Service ${SERVICE_KEY} restarted"
    
    # Show status
    echo ""
    echo "📊 Service status:"
    docker compose -f "$COMPOSE_FILE" ps "$SERVICE_KEY"
else
    echo "⚠️  Docker/docker-compose not found. Skipping container operations."
fi

echo ""
echo "✅ Deployment complete for ${SERVICE_KEY}"


