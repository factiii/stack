#!/bin/bash

# Write environment file from GitHub Secret/Variable
# Usage: ./scripts/write-env-file.sh <repo-name> <environment> <secret-name>
# Example: ./scripts/write-env-file.sh factiii staging FACTIII_STAGING_ENVS

set -e

REPO_NAME="$1"
ENVIRONMENT="$2"
SECRET_NAME="$3"
ENV_CONTENT="$4"  # Optional: if provided, use this instead of reading from secret

if [ -z "$REPO_NAME" ] || [ -z "$ENVIRONMENT" ] || [ -z "$SECRET_NAME" ]; then
    echo "Usage: $0 <repo-name> <environment> <secret-name> [env-content]"
    echo "Example: $0 factiii staging FACTIII_STAGING_ENVS"
    exit 1
fi

INFRASTRUCTURE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SECRETS_DIR="${INFRASTRUCTURE_ROOT}/secrets"
ENV_FILE="${SECRETS_DIR}/${REPO_NAME}-${ENVIRONMENT}.env"

# Create secrets directory if it doesn't exist
mkdir -p "$SECRETS_DIR"

# If env content is provided directly, use it
if [ -n "$ENV_CONTENT" ]; then
    echo "$ENV_CONTENT" > "$ENV_FILE"
    echo "✅ Wrote env file: $ENV_FILE"
    exit 0
fi

# Otherwise, try to read from environment variable (set by GitHub Actions)
if [ -n "${!SECRET_NAME}" ]; then
    ENV_CONTENT="${!SECRET_NAME}"
else
    echo "Warning: Secret $SECRET_NAME not found in environment" >&2
    echo "Creating empty template file. Fill in values manually." >&2
    cat > "$ENV_FILE" <<EOF
# Environment variables for ${REPO_NAME} (${ENVIRONMENT})
# This file should be populated from GitHub Secret: ${SECRET_NAME}
# Format: key=value (one per line)

NODE_ENV=${ENVIRONMENT}
PORT=5001
# Add other environment variables as needed
EOF
    exit 1
fi

# Parse the content - handle both JSON and key=value formats
if echo "$ENV_CONTENT" | grep -q '^{'; then
    # JSON format - convert to key=value
    if command -v jq &> /dev/null; then
        echo "$ENV_CONTENT" | jq -r 'to_entries[] | "\(.key)=\(.value)"' > "$ENV_FILE"
    else
        echo "Error: jq not found. Cannot parse JSON format." >&2
        echo "Please provide environment variables in key=value format (one per line)" >&2
        exit 1
    fi
else
    # Assume key=value format (one per line)
    echo "$ENV_CONTENT" > "$ENV_FILE"
fi

echo "✅ Wrote env file: $ENV_FILE"
