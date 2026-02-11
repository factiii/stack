#!/usr/bin/env bash
# =============================================================================
# canReach.sh - Simplified reachability check for deployment environments
# =============================================================================
#
# Replaces the complex canReach logic that previously depended on GitHub.
# This script checks whether a given environment is reachable via direct SSH
# and returns the appropriate routing decision.
#
# This mirrors the pipeline plugin's canReach() function but works standalone:
#   - dev     → always reachable locally
#   - secrets → needs vault password
#   - staging → needs SSH key + connectivity
#   - prod    → needs SSH key + connectivity
#
# Usage:
#   ./canReach.sh dev          # Always returns: local
#   ./canReach.sh secrets      # Checks vault access
#   ./canReach.sh staging      # Checks SSH to staging
#   ./canReach.sh prod         # Checks SSH to production
#   ./canReach.sh all          # Checks all environments
#
# Output (machine-readable):
#   ENV:REACHABLE:VIA        e.g., "staging:true:local"
#   ENV:UNREACHABLE:REASON   e.g., "prod:false:missing_ssh_key"
#
# Exit codes:
#   0 - All requested environments are reachable
#   1 - One or more environments are unreachable
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVENTORY_DIR="$(dirname "$SCRIPT_DIR")/inventory"
STAGE="${1:-all}"
ERRORS=0

# Colors (only for stderr/human-readable output)
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "$1" >&2; }
result() { echo "$1"; }  # Machine-readable output to stdout

SSH_TIMEOUT=5

# ---------------------------------------------------------------------------
# Check: dev
# ---------------------------------------------------------------------------
check_dev() {
    result "dev:true:local"
    log "  ${GREEN}✅ dev${NC}: always reachable locally"
}

# ---------------------------------------------------------------------------
# Check: secrets (vault access)
# ---------------------------------------------------------------------------
check_secrets() {
    # Check vault password availability
    if [[ -n "${ANSIBLE_VAULT_PASSWORD:-}" ]]; then
        result "secrets:true:local"
        log "  ${GREEN}✅ secrets${NC}: vault password available (env var)"
        return
    fi

    if [[ -n "${ANSIBLE_VAULT_PASSWORD_FILE:-}" && -f "${ANSIBLE_VAULT_PASSWORD_FILE:-}" ]]; then
        result "secrets:true:local"
        log "  ${GREEN}✅ secrets${NC}: vault password file found"
        return
    fi

    if [[ -f "$HOME/.vault_pass" ]]; then
        result "secrets:true:local"
        log "  ${GREEN}✅ secrets${NC}: default vault password file (~/.vault_pass)"
        return
    fi

    result "secrets:false:missing_vault_password"
    log "  ${RED}❌ secrets${NC}: no vault password configured"
    ERRORS=$((ERRORS + 1))
}

# ---------------------------------------------------------------------------
# Check: staging/prod (SSH connectivity)
# ---------------------------------------------------------------------------
check_ssh_env() {
    local env_name="$1"
    local key_path="$2"
    local inventory_file="$3"

    # 1. Check if running on the server itself (equivalent to GITHUB_ACTIONS=true)
    if [[ "${FACTIII_ON_SERVER:-}" == "true" ]]; then
        result "${env_name}:true:local"
        log "  ${GREEN}✅ ${env_name}${NC}: running on server (local)"
        return
    fi

    # 2. Check SSH key exists
    if [[ ! -f "$key_path" ]]; then
        result "${env_name}:false:missing_ssh_key"
        log "  ${RED}❌ ${env_name}${NC}: SSH key not found: $key_path"
        ERRORS=$((ERRORS + 1))
        return
    fi

    # 3. Check inventory has real values (not CHANGEME)
    if [[ -f "$inventory_file" ]] && grep -q "CHANGEME" "$inventory_file"; then
        result "${env_name}:false:unconfigured_inventory"
        log "  ${RED}❌ ${env_name}${NC}: inventory has CHANGEME placeholders"
        ERRORS=$((ERRORS + 1))
        return
    fi

    # 4. Quick SSH connectivity test
    if [[ ! -f "$inventory_file" ]]; then
        result "${env_name}:false:missing_inventory"
        log "  ${RED}❌ ${env_name}${NC}: inventory file not found"
        ERRORS=$((ERRORS + 1))
        return
    fi

    # Extract host and user from inventory (simple parse)
    local host user
    host=$(grep "ansible_host:" "$inventory_file" | head -1 | awk '{print $2}' | tr -d '"')
    user=$(grep "ansible_user:" "$inventory_file" | head -1 | awk '{print $2}' | tr -d '"')

    if [[ -z "$host" || -z "$user" ]]; then
        result "${env_name}:false:invalid_inventory"
        log "  ${RED}❌ ${env_name}${NC}: cannot parse host/user from inventory"
        ERRORS=$((ERRORS + 1))
        return
    fi

    # 5. Test actual connectivity
    if ssh -i "$key_path" \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=$SSH_TIMEOUT \
        -o BatchMode=yes \
        "${user}@${host}" \
        "echo ok" &>/dev/null; then
        result "${env_name}:true:ssh"
        log "  ${GREEN}✅ ${env_name}${NC}: reachable via SSH (${user}@${host})"
    else
        result "${env_name}:false:connection_failed"
        log "  ${RED}❌ ${env_name}${NC}: SSH connection failed to ${user}@${host}"
        ERRORS=$((ERRORS + 1))
    fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
log ""
log "${YELLOW}Factiii Reachability Check${NC}"
log "━━━━━━━━━━━━━━━━━━━━━━━━━"

case "$STAGE" in
    dev)
        check_dev
        ;;
    secrets)
        check_secrets
        ;;
    staging)
        check_ssh_env "staging" "$HOME/.ssh/staging_deploy_key" "$INVENTORY_DIR/staging.yml"
        ;;
    prod)
        check_ssh_env "prod" "$HOME/.ssh/prod_deploy_key" "$INVENTORY_DIR/production.yml"
        ;;
    mac)
        check_ssh_env "mac" "$HOME/.ssh/mac_deploy_key" "$INVENTORY_DIR/mac.yml"
        ;;
    all)
        check_dev
        check_secrets
        check_ssh_env "mac" "$HOME/.ssh/mac_deploy_key" "$INVENTORY_DIR/mac.yml"
        check_ssh_env "staging" "$HOME/.ssh/staging_deploy_key" "$INVENTORY_DIR/staging.yml"
        check_ssh_env "prod" "$HOME/.ssh/prod_deploy_key" "$INVENTORY_DIR/production.yml"
        ;;
    *)
        log "${RED}Unknown stage: $STAGE${NC}"
        log "Usage: $0 [dev|secrets|staging|prod|mac|all]"
        exit 1
        ;;
esac

log ""
if [[ $ERRORS -eq 0 ]]; then
    log "${GREEN}All requested environments are reachable.${NC}"
    exit 0
else
    log "${RED}$ERRORS environment(s) unreachable.${NC}"
    exit 1
fi
