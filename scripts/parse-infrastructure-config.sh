#!/bin/bash

# ============================================================================
# LEGACY SCRIPT - For backward compatibility with centralized approach
# ============================================================================
# This script is part of the legacy centralized factiii.yml
# approach. For new repositories, use the decentralized approach with
# the npm package CLI commands (npx factiii check-config, etc.)
# ============================================================================
#
# Parse factiii.yml and extract server/repo mappings
# Usage: source this script to use functions, or call directly with function name

set -e

INFRASTRUCTURE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="${INFRASTRUCTURE_ROOT}/factiii.yml"

# Check if config file exists
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Error: factiii.yml not found at $CONFIG_FILE" >&2
    exit 1
fi

# Function to get servers for a repo/environment
get_servers_for_repo() {
    local repo_name="$1"
    local env="$2"
    
    if [ -z "$repo_name" ] || [ -z "$env" ]; then
        echo "Usage: get_servers_for_repo <repo-name> <environment>" >&2
        return 1
    fi
    
    # Use yq if available, otherwise use grep/sed
    if command -v yq &> /dev/null; then
        yq eval ".servers | to_entries | .[] | select(.value.repos[]?.name == \"$repo_name\" and .value.repos[]?.environment == \"$env\") | .key" "$CONFIG_FILE" | tr '\n' ' '
    else
        # Fallback: parse with grep/sed (basic implementation)
        grep -A 20 "repos:" "$CONFIG_FILE" | grep -B 5 "name: $repo_name" | grep -B 5 "environment: $env" | grep -E "^  [a-z_]+:" | sed 's/:$//' | sed 's/^  //' | sort -u | tr '\n' ' '
    fi
}

# Function to get repos for a server
get_repos_for_server() {
    local server_name="$1"
    
    if [ -z "$server_name" ]; then
        echo "Usage: get_repos_for_server <server-name>" >&2
        return 1
    fi
    
    if command -v yq &> /dev/null; then
        yq eval ".servers.$server_name.repos[] | \"\(.name):\(.environment)\"" "$CONFIG_FILE"
    else
        # Fallback implementation
        awk "/^  $server_name:/{flag=1} flag && /^  [a-z]/ && !/^  $server_name:/{flag=0} flag && /name:/{print}" "$CONFIG_FILE" | sed 's/.*name: //' | sed 's/.*environment: //'
    fi
}

# Function to get SSH secret name for a server
get_ssh_secret() {
    local server_name="$1"
    
    if [ -z "$server_name" ]; then
        echo "Usage: get_ssh_secret <server-name>" >&2
        return 1
    fi
    
    if command -v yq &> /dev/null; then
        yq eval ".servers.$server_name.ssh_key_secret" "$CONFIG_FILE"
    else
        grep -A 10 "^  $server_name:" "$CONFIG_FILE" | grep "ssh_key_secret:" | sed 's/.*ssh_key_secret: //'
    fi
}

# Function to get SSH host for a server
get_ssh_host() {
    local server_name="$1"
    
    if [ -z "$server_name" ]; then
        echo "Usage: get_ssh_host <server-name>" >&2
        return 1
    fi
    
    if command -v yq &> /dev/null; then
        yq eval ".servers.$server_name.host" "$CONFIG_FILE"
    else
        grep -A 10 "^  $server_name:" "$CONFIG_FILE" | grep "host:" | sed 's/.*host: //'
    fi
}

# Function to get SSH user for a server
get_ssh_user() {
    local server_name="$1"
    
    if [ -z "$server_name" ]; then
        echo "Usage: get_ssh_user <server-name>" >&2
        return 1
    fi
    
    if command -v yq &> /dev/null; then
        yq eval ".servers.$server_name.user" "$CONFIG_FILE"
    else
        grep -A 10 "^  $server_name:" "$CONFIG_FILE" | grep "user:" | sed 's/.*user: //'
    fi
}

# Function to get domain for a repo/environment
get_domain() {
    local repo_name="$1"
    local env="$2"
    local server_name="$3"
    
    if [ -z "$repo_name" ] || [ -z "$env" ]; then
        echo "Usage: get_domain <repo-name> <environment> [server-name]" >&2
        return 1
    fi
    
    # Get explicit domain from config
    local domain
    if [ -n "$server_name" ]; then
        if command -v yq &> /dev/null; then
            domain=$(yq eval ".servers.$server_name.repos[] | select(.name == \"$repo_name\" and .environment == \"$env\") | .domain" "$CONFIG_FILE" | head -1)
        else
            # Fallback: basic grep
            domain=$(grep -A 20 "^  $server_name:" "$CONFIG_FILE" | grep -A 5 "name: $repo_name" | grep "domain:" | sed 's/.*domain: //' | head -1)
        fi
    else
        # If no server specified, get from first matching server
        if command -v yq &> /dev/null; then
            domain=$(yq eval ".servers | to_entries | .[] | .value.repos[] | select(.name == \"$repo_name\" and .environment == \"$env\") | .domain" "$CONFIG_FILE" | head -1)
        fi
    fi
    
    if [ -n "$domain" ]; then
        echo "$domain"
    else
        echo "Error: Domain not found for $repo_name ($env)" >&2
        return 1
    fi
}

# Function to get SSL email
get_ssl_email() {
    if command -v yq &> /dev/null; then
        yq eval ".ssl_email" "$CONFIG_FILE"
    else
        grep "^ssl_email:" "$CONFIG_FILE" | sed 's/.*ssl_email: //'
    fi
}

# If called directly with function name, execute it
if [ -n "$1" ] && [ "$(type -t "$1")" = "function" ]; then
    "$@"
fi
