#!/bin/bash

# Deployment script for infrastructure repos
# Usage: ./scripts/deploy.sh <repo-name> <environment>
# Example: ./scripts/deploy.sh chop-shop prod

set -e

REPO_NAME=$1
ENVIRONMENT=$2

if [ -z "$REPO_NAME" ] || [ -z "$ENVIRONMENT" ]; then
    echo "Usage: $0 <repo-name> <environment>"
    echo "Example: $0 chop-shop prod"
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
cd "$(dirname "$0")/.."
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
cd "$(dirname "$0")/.."

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

