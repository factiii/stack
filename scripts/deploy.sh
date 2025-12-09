#!/bin/bash

# Deployment script for infrastructure repos
# Usage: ./scripts/deploy.sh <repo-name> [environment]
# Example: ./scripts/deploy.sh chop-shop prod
# If environment is not specified, uses INFRA_ENV from infra.conf

set -e

INFRASTRUCTURE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
INFRA_CONF="${INFRASTRUCTURE_ROOT}/infra.conf"
CONFIG_FILE="${INFRASTRUCTURE_ROOT}/infrastructure-config.yml"

REPO_NAME=$1
ENVIRONMENT=$2

# If environment not provided, try to determine from infrastructure config or infra.conf
if [ -z "$ENVIRONMENT" ]; then
    # Try infrastructure-config.yml first (new approach)
    if [ -f "$CONFIG_FILE" ] && command -v yq &> /dev/null; then
        # Try to get environment from config (would need server context)
        # For now, fall back to infra.conf
        if [ -f "$INFRA_CONF" ]; then
            source "$INFRA_CONF"
            ENVIRONMENT="$INFRA_ENV"
            echo "📋 Using environment from infra.conf: ${ENVIRONMENT}"
        fi
    elif [ -f "$INFRA_CONF" ]; then
        source "$INFRA_CONF"
        ENVIRONMENT="$INFRA_ENV"
        echo "📋 Using environment from infra.conf: ${ENVIRONMENT}"
    fi
fi

if [ -z "$REPO_NAME" ]; then
    echo "Usage: $0 <repo-name> [environment]"
    echo "Example: $0 chop-shop prod"
    echo ""
    echo "If environment is omitted, uses INFRA_ENV from infra.conf"
    exit 1
fi

if [ -z "$ENVIRONMENT" ]; then
    echo "Error: No environment specified and infra.conf not found"
    echo "Either specify environment or create infra.conf with INFRA_ENV=staging|prod"
    exit 1
fi

if [ "$ENVIRONMENT" != "prod" ] && [ "$ENVIRONMENT" != "staging" ]; then
    echo "Error: Environment must be 'prod' or 'staging'"
    exit 1
fi

SERVICE_NAME="${REPO_NAME}-${ENVIRONMENT}"
REPO_PATH="./repos/${REPO_NAME}"

echo "🚀 Deploying ${SERVICE_NAME}..."

# Step 1: Pull infrastructure repo
echo "📥 Pulling infrastructure repo..."
cd "$INFRASTRUCTURE_ROOT"
git pull origin main || echo "Warning: Could not pull infrastructure repo"

# Step 2: Pull project repo
if [ ! -d "$REPO_PATH" ]; then
    echo "Error: Repo not found at $REPO_PATH"
    echo "Run ./scripts/setup-repo.sh first to clone the repo"
    exit 1
fi

echo "📥 Pulling ${REPO_NAME} repo..."
cd "$REPO_PATH"
git pull origin main || git pull origin master || echo "Warning: Could not pull repo"

# Step 3: Return to infrastructure root
cd "$INFRASTRUCTURE_ROOT"

# Step 4: Build and deploy via docker compose
echo "🔨 Building ${SERVICE_NAME}..."
docker-compose build "${SERVICE_NAME}"

echo "🚀 Starting ${SERVICE_NAME}..."
docker-compose up -d "${SERVICE_NAME}"

# Step 5: Check health
echo "🏥 Checking health of ${SERVICE_NAME}..."
MAX_ATTEMPTS=30
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if docker-compose ps "${SERVICE_NAME}" | grep -q "healthy\|Up"; then
        HEALTH_STATUS=$(docker inspect --format='{{.State.Health.Status}}' "infrastructure_${SERVICE_NAME}" 2>/dev/null || echo "no-healthcheck")
        
        if [ "$HEALTH_STATUS" = "healthy" ] || [ "$HEALTH_STATUS" = "no-healthcheck" ]; then
            echo "✅ ${SERVICE_NAME} is healthy and running!"
            docker-compose ps "${SERVICE_NAME}"
            exit 0
        fi
    fi
    
    ATTEMPT=$((ATTEMPT + 1))
    echo "⏳ Waiting for ${SERVICE_NAME} to be healthy... (${ATTEMPT}/${MAX_ATTEMPTS})"
    sleep 2
done

echo "❌ ${SERVICE_NAME} failed to become healthy after ${MAX_ATTEMPTS} attempts"
docker-compose logs --tail=50 "${SERVICE_NAME}"
exit 1

