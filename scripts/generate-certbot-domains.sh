#!/bin/bash

# ============================================================================
# LEGACY SCRIPT - For backward compatibility with centralized approach
# ============================================================================
# This script is part of the legacy centralized factiii.yml
# approach. For new repositories, use the decentralized approach with
# the npm package CLI commands (npx factiii check-config, etc.)
# ============================================================================
#
# Generate certbot domain list from factiii.yml
# Usage: ./scripts/generate-certbot-domains.sh
# Outputs: space-separated list of domains for certbot -d flags

set -e

INFRASTRUCTURE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="${INFRASTRUCTURE_ROOT}/factiii.yml"

# Source the parse script
source "${INFRASTRUCTURE_ROOT}/scripts/parse-infrastructure-config.sh"

DOMAINS=()

# Collect all domains from config
if command -v yq &> /dev/null; then
    # Use yq to parse YAML - extract explicit domain fields
    while IFS='|' read -r repo_name env server_name; do
        domain=$(get_domain "$repo_name" "$env" "$server_name")
        if [ -n "$domain" ]; then
            DOMAINS+=("$domain")
        fi
    done < <(yq eval '.servers | to_entries | .[] | .key as $server | .value.repos[] | "\(.name)|\(.environment)|\($server)"' "$CONFIG_FILE")
else
    # Fallback: basic grep/sed parsing to extract explicit domain fields
    echo "Warning: yq not found. Install yq for better results." >&2
    # Extract domains directly from config file using grep/sed
    while IFS= read -r line; do
        if echo "$line" | grep -q "domain:"; then
            domain=$(echo "$line" | sed 's/.*domain: *//' | sed 's/ *#.*$//' | xargs)
            if [ -n "$domain" ]; then
                DOMAINS+=("$domain")
            fi
        fi
    done < "$CONFIG_FILE"
fi

# Remove duplicates and output
printf '%s\n' "${DOMAINS[@]}" | sort -u | tr '\n' ' '
