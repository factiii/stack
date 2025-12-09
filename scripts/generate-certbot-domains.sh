#!/bin/bash

# Generate certbot domain list from infrastructure-config.yml
# Usage: ./scripts/generate-certbot-domains.sh
# Outputs: space-separated list of domains for certbot -d flags

set -e

INFRASTRUCTURE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="${INFRASTRUCTURE_ROOT}/infrastructure-config.yml"

# Source the parse script
source "${INFRASTRUCTURE_ROOT}/scripts/parse-infrastructure-config.sh"

DOMAINS=()

# Collect all domains from config
if command -v yq &> /dev/null; then
    # Use yq to parse YAML
    while IFS='|' read -r repo_name env domain_override server_name; do
        domain=$(get_domain "$repo_name" "$env" "$server_name")
        DOMAINS+=("$domain")
    done < <(yq eval '.servers | to_entries | .[] | .key as $server | .value.repos[] | "\(.name)|\(.environment)|\(.domain_override // "")|\($server)"' "$CONFIG_FILE")
else
    # Fallback: basic grep/sed parsing
    echo "Warning: yq not found. Install yq for better results." >&2
    # Basic fallback implementation
    BASE_DOMAIN=$(get_base_domain)
    # This is a simplified version - would need more complex parsing
    echo "Error: yq required for domain generation" >&2
    exit 1
fi

# Remove duplicates and output
printf '%s\n' "${DOMAINS[@]}" | sort -u | tr '\n' ' '
