#!/usr/bin/env bash
# =============================================================================
# verify-secrets.sh - Verify all required secrets exist locally
# =============================================================================
#
# Checks that all SSH keys, env files, and Ansible Vault credentials
# are present and properly configured before attempting deployments.
#
# Usage:
#   ./verify-secrets.sh              # Check all environments
#   ./verify-secrets.sh --env mac    # Check mac only
#   ./verify-secrets.sh --env staging
#   ./verify-secrets.sh --env prod
#
# Exit codes:
#   0 - All checks passed
#   1 - One or more checks failed
# =============================================================================

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ERRORS=0
WARNINGS=0
ENV_FILTER="${2:-all}"

# Helper functions
pass() { echo -e "  ${GREEN}✅ PASS${NC}: $1"; }
fail() { echo -e "  ${RED}❌ FAIL${NC}: $1"; ERRORS=$((ERRORS + 1)); }
warn() { echo -e "  ${YELLOW}⚠️  WARN${NC}: $1"; WARNINGS=$((WARNINGS + 1)); }
header() { echo -e "\n${YELLOW}━━━ $1 ━━━${NC}"; }

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --env) ENV_FILTER="$2"; shift 2 ;;
        --help|-h)
            echo "Usage: $0 [--env mac|staging|prod|all]"
            echo ""
            echo "Verifies that all required secrets and credentials exist locally."
            echo "Run this before attempting any deployment or SSH operation."
            exit 0
            ;;
        *) shift ;;
    esac
done

echo "========================================"
echo "  Factiii Secret Verification"
echo "========================================"
echo "Checking environment: ${ENV_FILTER}"

# ---------------------------------------------------------------------------
# 1. Ansible Vault Password
# ---------------------------------------------------------------------------
header "Ansible Vault Password"

if [[ -n "${ANSIBLE_VAULT_PASSWORD:-}" ]]; then
    pass "ANSIBLE_VAULT_PASSWORD environment variable is set"
elif [[ -n "${ANSIBLE_VAULT_PASSWORD_FILE:-}" ]]; then
    if [[ -f "${ANSIBLE_VAULT_PASSWORD_FILE}" ]]; then
        pass "Vault password file exists: ${ANSIBLE_VAULT_PASSWORD_FILE}"
    else
        fail "ANSIBLE_VAULT_PASSWORD_FILE is set but file not found: ${ANSIBLE_VAULT_PASSWORD_FILE}"
    fi
elif [[ -f ~/.vault_pass ]]; then
    pass "Default vault password file found: ~/.vault_pass"
else
    fail "No vault password configured. Set ANSIBLE_VAULT_PASSWORD, ANSIBLE_VAULT_PASSWORD_FILE, or create ~/.vault_pass"
fi

# Check ansible-vault CLI is available
if command -v ansible-vault &> /dev/null; then
    pass "ansible-vault CLI is installed"
else
    fail "ansible-vault CLI not found. Install Ansible: pip install ansible"
fi

# ---------------------------------------------------------------------------
# 2. SSH Keys
# ---------------------------------------------------------------------------
check_ssh_key() {
    local name="$1"
    local path="$2"

    if [[ -f "$path" ]]; then
        # Check permissions (should be 600 or 400)
        local perms
        perms=$(stat -f "%Lp" "$path" 2>/dev/null || stat -c "%a" "$path" 2>/dev/null)
        if [[ "$perms" == "600" || "$perms" == "400" ]]; then
            pass "$name SSH key exists with correct permissions ($perms): $path"
        else
            warn "$name SSH key exists but permissions are $perms (should be 600): $path"
        fi
    else
        fail "$name SSH key not found: $path"
    fi
}

if [[ "$ENV_FILTER" == "all" || "$ENV_FILTER" == "mac" ]]; then
    header "SSH Keys - Mac"
    check_ssh_key "Mac" "$HOME/.ssh/mac_deploy_key"
fi

if [[ "$ENV_FILTER" == "all" || "$ENV_FILTER" == "staging" ]]; then
    header "SSH Keys - Staging"
    check_ssh_key "Staging" "$HOME/.ssh/staging_deploy_key"
fi

if [[ "$ENV_FILTER" == "all" || "$ENV_FILTER" == "prod" ]]; then
    header "SSH Keys - Production"
    check_ssh_key "Production" "$HOME/.ssh/prod_deploy_key"
fi

# ---------------------------------------------------------------------------
# 2b. SSH Connectivity Tests
# ---------------------------------------------------------------------------
# Actually attempt SSH connections to verify keys work end-to-end

SSH_TIMEOUT=5

test_ssh_connectivity() {
    local name="$1"
    local key="$2"
    local inventory="$3"

    # Skip if key doesn't exist (already reported above)
    if [[ ! -f "$key" ]]; then
        return
    fi

    # Skip if inventory has CHANGEME placeholders
    if [[ -f "$inventory" ]] && grep -q "CHANGEME" "$inventory"; then
        warn "$name SSH connectivity: inventory has CHANGEME placeholders, skipping"
        return
    fi

    # Parse host and user from inventory file
    if [[ ! -f "$inventory" ]]; then
        warn "$name SSH connectivity: inventory file not found: $inventory"
        return
    fi

    local host user
    host=$(grep "ansible_host:" "$inventory" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')
    user=$(grep "ansible_user:" "$inventory" 2>/dev/null | head -1 | awk '{print $2}' | tr -d '"')

    if [[ -z "$host" || -z "$user" ]]; then
        warn "$name SSH connectivity: cannot parse host/user from inventory"
        return
    fi

    # Attempt actual SSH connection
    if ssh -i "$key" \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=$SSH_TIMEOUT \
        -o BatchMode=yes \
        "${user}@${host}" \
        "echo ok" &>/dev/null; then
        pass "$name SSH connectivity: connected to ${user}@${host}"
    else
        fail "$name SSH connectivity: cannot reach ${user}@${host}"
    fi
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVENTORY_DIR="$(dirname "$SCRIPT_DIR")/inventory"

if [[ "$ENV_FILTER" == "all" || "$ENV_FILTER" == "mac" ]]; then
    header "SSH Connectivity - Mac"
    test_ssh_connectivity "Mac" "$HOME/.ssh/mac_deploy_key" "$INVENTORY_DIR/mac.yml"
fi

if [[ "$ENV_FILTER" == "all" || "$ENV_FILTER" == "staging" ]]; then
    header "SSH Connectivity - Staging"
    test_ssh_connectivity "Staging" "$HOME/.ssh/staging_deploy_key" "$INVENTORY_DIR/staging.yml"
fi

if [[ "$ENV_FILTER" == "all" || "$ENV_FILTER" == "prod" ]]; then
    header "SSH Connectivity - Production"
    test_ssh_connectivity "Production" "$HOME/.ssh/prod_deploy_key" "$INVENTORY_DIR/production.yml"
fi

# ---------------------------------------------------------------------------
# 3. Environment Files
# ---------------------------------------------------------------------------
header "Environment Files"

# Look for .env files in the current project or standard locations
check_env_file() {
    local name="$1"
    local path="$2"

    if [[ -f "$path" ]]; then
        # Check it's not empty
        if [[ -s "$path" ]]; then
            pass "$name exists and is not empty: $path"
        else
            warn "$name exists but is empty: $path"
        fi
    else
        fail "$name not found: $path"
    fi
}

if [[ "$ENV_FILTER" == "all" || "$ENV_FILTER" == "mac" ]]; then
    check_env_file ".env (development)" ".env"
fi

if [[ "$ENV_FILTER" == "all" || "$ENV_FILTER" == "staging" ]]; then
    check_env_file ".env.staging" ".env.staging"
fi

if [[ "$ENV_FILTER" == "all" || "$ENV_FILTER" == "prod" ]]; then
    check_env_file ".env.prod" ".env.prod"
fi

# ---------------------------------------------------------------------------
# 4. Vault File
# ---------------------------------------------------------------------------
header "Vault File"

# Check common vault file locations
VAULT_FOUND=false
for vault_path in \
    "ansible/vault/secrets.yml" \
    "group_vars/all/vault.yml" \
    "vault.yml"; do
    if [[ -f "$vault_path" ]]; then
        pass "Vault file found: $vault_path"
        VAULT_FOUND=true

        # Try to verify it's encrypted
        if head -1 "$vault_path" | grep -q '^\$ANSIBLE_VAULT;'; then
            pass "Vault file is encrypted"
        else
            warn "Vault file does not appear to be encrypted: $vault_path"
        fi
        break
    fi
done

if [[ "$VAULT_FOUND" == "false" ]]; then
    warn "No vault file found. Expected at ansible/vault/secrets.yml or group_vars/all/vault.yml"
fi

# ---------------------------------------------------------------------------
# 5. Ansible Vault Secrets (if vault is accessible)
# ---------------------------------------------------------------------------
header "Vault Secret Contents"

check_vault_secret() {
    local secret_name="$1"
    # Use factiii CLI to check if available
    if command -v npx &> /dev/null; then
        if npx stack secrets list 2>/dev/null | grep -q "$secret_name"; then
            pass "Vault contains: $secret_name"
        else
            warn "Cannot verify vault secret: $secret_name (run 'npx stack secrets list' manually)"
        fi
    else
        warn "npx not available - cannot verify vault secrets"
    fi
}

if [[ "$ENV_FILTER" == "all" || "$ENV_FILTER" == "staging" ]]; then
    check_vault_secret "STAGING_SSH"
fi

if [[ "$ENV_FILTER" == "all" || "$ENV_FILTER" == "prod" ]]; then
    check_vault_secret "PROD_SSH"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "========================================"
echo "  Results"
echo "========================================"

if [[ $ERRORS -eq 0 && $WARNINGS -eq 0 ]]; then
    echo -e "  ${GREEN}All checks passed!${NC}"
    echo ""
    echo "  You're ready to run deployments."
    exit 0
elif [[ $ERRORS -eq 0 ]]; then
    echo -e "  ${YELLOW}$WARNINGS warning(s), 0 errors${NC}"
    echo ""
    echo "  Deployments may work but review warnings above."
    exit 0
else
    echo -e "  ${RED}$ERRORS error(s), $WARNINGS warning(s)${NC}"
    echo ""
    echo "  Fix the errors above before attempting deployments."
    echo "  See ansible/docs/VAULT_SETUP.md for setup instructions."
    exit 1
fi
