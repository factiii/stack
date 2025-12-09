#!/bin/bash

# Helper script to add new repos to infrastructure
# Usage: ./scripts/setup-repo.sh <repo-name> <git-url>
# Example: ./scripts/setup-repo.sh my-repo https://github.com/user/my-repo.git

set -e

REPO_NAME=$1
GIT_URL=$2

if [ -z "$REPO_NAME" ] || [ -z "$GIT_URL" ]; then
    echo "Usage: $0 <repo-name> <git-url>"
    echo "Example: $0 my-repo https://github.com/user/my-repo.git"
    exit 1
fi

INFRASTRUCTURE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REPOS_DIR="${INFRASTRUCTURE_ROOT}/repos"
SECRETS_DIR="${INFRASTRUCTURE_ROOT}/secrets"
REPO_PATH="${REPOS_DIR}/${REPO_NAME}"

echo "🔧 Setting up ${REPO_NAME}..."

# Create repos directory if it doesn't exist
mkdir -p "$REPOS_DIR"
mkdir -p "$SECRETS_DIR"

# Clone repo
if [ -d "$REPO_PATH" ]; then
    echo "⚠️  Repo already exists at $REPO_PATH"
    read -p "Do you want to remove it and re-clone? (y/N) " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        rm -rf "$REPO_PATH"
    else
        echo "Skipping clone..."
        exit 0
    fi
fi

echo "📥 Cloning ${REPO_NAME} from ${GIT_URL}..."

# Try to clone, handle authentication errors gracefully
set +e
git clone "$GIT_URL" "$REPO_PATH" 2>&1
CLONE_EXIT_CODE=$?
set -e

if [ $CLONE_EXIT_CODE -ne 0 ]; then
    echo ""
    echo "❌ Failed to clone repository. Authentication error detected."
    echo ""
    echo "💡 GitHub no longer supports password authentication. Use one of these options:"
    echo ""
    echo "   Option 1: Use SSH (recommended if you have SSH keys set up):"
    SSH_URL="git@github.com:$(echo "$GIT_URL" | sed 's|https://github.com/||' | sed 's|\.git$||').git"
    echo "     ./scripts/setup-repo.sh ${REPO_NAME} ${SSH_URL}"
    echo ""
    echo "   Option 2: Use a Personal Access Token:"
    echo "     - Create a token at: https://github.com/settings/tokens"
    echo "     - Use it as the password when prompted"
    REPO_PATH_PART="$(echo "$GIT_URL" | sed 's|https://github.com/||')"
    echo "     - Or use: git clone https://<token>@github.com/${REPO_PATH_PART}"
    echo ""
    exit 1
fi

# Check if Dockerfile exists
DOCKERFILE_PATH="${REPO_PATH}/apps/server/Dockerfile"
if [ ! -f "$DOCKERFILE_PATH" ]; then
    echo "⚠️  Warning: Dockerfile not found at ${DOCKERFILE_PATH}"
    echo "   You may need to update the docker-compose.yml with the correct path"
fi

# Create example .env files
PROD_ENV="${SECRETS_DIR}/${REPO_NAME}-prod.env"
STAGING_ENV="${SECRETS_DIR}/${REPO_NAME}-staging.env"

echo "📝 Creating example .env files..."

# Production env file
if [ ! -f "$PROD_ENV" ]; then
    cat > "$PROD_ENV" <<EOF
# Production environment variables for ${REPO_NAME}
# Add your production secrets here
NODE_ENV=production
PORT=5001
# DATABASE_URL=postgresql://user:pass@host:5432/dbname
# Add other environment variables as needed
EOF
    echo "✅ Created ${PROD_ENV}"
else
    echo "⚠️  ${PROD_ENV} already exists, skipping..."
fi

# Staging env file
if [ ! -f "$STAGING_ENV" ]; then
    cat > "$STAGING_ENV" <<EOF
# Staging environment variables for ${REPO_NAME}
# Add your staging secrets here
NODE_ENV=staging
PORT=5001
DATABASE_URL=postgresql://postgres:postgres@postgres-staging:5432/${REPO_NAME}_staging
# Add other environment variables as needed
EOF
    echo "✅ Created ${STAGING_ENV}"
else
    echo "⚠️  ${STAGING_ENV} already exists, skipping..."
fi

echo ""
echo "✅ Setup complete for ${REPO_NAME}!"
echo ""
echo "📋 Next steps:"
echo "   1. Edit the .env files in ${SECRETS_DIR}/"
echo "      - ${REPO_NAME}-prod.env"
echo "      - ${REPO_NAME}-staging.env"
echo ""
echo "   2. Add services to docker-compose.yml:"
echo "      - ${REPO_NAME}-prod"
echo "      - ${REPO_NAME}-staging"
echo ""
echo "   3. Update nginx/nginx.conf with routing rules"
echo ""
echo "   4. Deploy with:"
echo "      ./scripts/deploy.sh ${REPO_NAME} prod"
echo "      ./scripts/deploy.sh ${REPO_NAME} staging"

