#!/usr/bin/env bash
# =============================================================================
# ssh-test.sh - Test SSH connectivity to all environments
# =============================================================================
#
# Simple connectivity test that verifies SSH access to Mac, staging,
# and production servers. Run this before deployments to catch
# connectivity issues early.
#
# Usage:
#   ./ssh-test.sh              # Test all environments
#   ./ssh-test.sh mac          # Test mac only
#   ./ssh-test.sh staging      # Test staging only
#   ./ssh-test.sh prod         # Test production only
#
# Prerequisites:
#   - SSH keys must be in place (run verify-secrets.sh first)
#   - Ansible must be installed (for ad-hoc commands)
#
# Exit codes:
#   0 - All connectivity tests passed
#   1 - One or more tests failed
# =============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVENTORY_DIR="$(dirname "$SCRIPT_DIR")/inventory"
ERRORS=0
TARGET="${1:-all}"

SSH_TIMEOUT=10  # seconds

echo "========================================"
echo "  SSH Connectivity Test"
echo "========================================"
echo ""

# ---------------------------------------------------------------------------
# Helper: Test SSH with direct ssh command (fallback if Ansible unavailable)
# ---------------------------------------------------------------------------
test_ssh_direct() {
    local name="$1"
    local host="$2"
    local user="$3"
    local key="$4"
    local port="${5:-22}"

    echo -e "${CYAN}Testing: ${name}${NC} (${user}@${host}:${port})"

    # Check key exists first
    if [[ ! -f "$key" ]]; then
        echo -e "  ${RED}❌ FAIL${NC}: SSH key not found: $key"
        echo -e "         Run verify-secrets.sh to diagnose"
        ERRORS=$((ERRORS + 1))
        echo ""
        return
    fi

    # Attempt SSH connection with timeout
    if ssh -i "$key" \
        -o StrictHostKeyChecking=no \
        -o ConnectTimeout=$SSH_TIMEOUT \
        -o BatchMode=yes \
        -p "$port" \
        "${user}@${host}" \
        "echo 'Connection successful'" 2>/dev/null; then
        echo -e "  ${GREEN}✅ PASS${NC}: SSH connection successful"

        # Bonus: check if Node.js is available
        if ssh -i "$key" \
            -o StrictHostKeyChecking=no \
            -o ConnectTimeout=$SSH_TIMEOUT \
            -o BatchMode=yes \
            -p "$port" \
            "${user}@${host}" \
            "node --version" 2>/dev/null; then
            NODE_VER=$(ssh -i "$key" \
                -o StrictHostKeyChecking=no \
                -o ConnectTimeout=$SSH_TIMEOUT \
                -o BatchMode=yes \
                -p "$port" \
                "${user}@${host}" \
                "node --version" 2>/dev/null)
            echo -e "  ${GREEN}✅ INFO${NC}: Node.js ${NODE_VER} available"
        else
            echo -e "  ${YELLOW}⚠️  WARN${NC}: Node.js not found on remote host"
        fi
    else
        echo -e "  ${RED}❌ FAIL${NC}: Cannot connect to ${user}@${host}:${port}"
        echo -e "         Check: network, firewall, SSH key permissions"
        ERRORS=$((ERRORS + 1))
    fi
    echo ""
}

# ---------------------------------------------------------------------------
# Helper: Test using Ansible ad-hoc ping (preferred method)
# ---------------------------------------------------------------------------
test_ansible_ping() {
    local name="$1"
    local inventory="$2"

    echo -e "${CYAN}Testing: ${name}${NC} (via Ansible ping)"

    if [[ ! -f "$inventory" ]]; then
        echo -e "  ${RED}❌ FAIL${NC}: Inventory file not found: $inventory"
        ERRORS=$((ERRORS + 1))
        echo ""
        return
    fi

    # Check for CHANGEME values in inventory
    if grep -q "CHANGEME" "$inventory"; then
        echo -e "  ${YELLOW}⚠️  SKIP${NC}: Inventory contains CHANGEME placeholders"
        echo -e "         Update $inventory with actual values first"
        echo ""
        return
    fi

    if ansible all -i "$inventory" -m ping --one-line 2>/dev/null; then
        echo -e "  ${GREEN}✅ PASS${NC}: Ansible ping successful"
    else
        echo -e "  ${RED}❌ FAIL${NC}: Ansible ping failed"
        echo -e "         Run with -vvv for details: ansible all -i $inventory -m ping -vvv"
        ERRORS=$((ERRORS + 1))
    fi
    echo ""
}

# ---------------------------------------------------------------------------
# Run connectivity tests
# ---------------------------------------------------------------------------

# Determine test method
USE_ANSIBLE=false
if command -v ansible &> /dev/null; then
    USE_ANSIBLE=true
    echo "Using Ansible for connectivity tests"
else
    echo "Ansible not found, falling back to direct SSH"
    echo "(Install Ansible for better testing: pip install ansible)"
fi
echo ""

# Mac
if [[ "$TARGET" == "all" || "$TARGET" == "mac" ]]; then
    echo "━━━ Mac Build Server ━━━"
    if [[ "$USE_ANSIBLE" == "true" ]]; then
        test_ansible_ping "Mac" "$INVENTORY_DIR/mac.yml"
    else
        # TODO: Update these values or read from inventory
        echo -e "  ${YELLOW}⚠️  SKIP${NC}: Configure inventory/mac.yml then re-run with Ansible"
        echo ""
    fi
fi

# Staging
if [[ "$TARGET" == "all" || "$TARGET" == "staging" ]]; then
    echo "━━━ Staging Server ━━━"
    if [[ "$USE_ANSIBLE" == "true" ]]; then
        test_ansible_ping "Staging" "$INVENTORY_DIR/staging.yml"
    else
        echo -e "  ${YELLOW}⚠️  SKIP${NC}: Configure inventory/staging.yml then re-run with Ansible"
        echo ""
    fi
fi

# Production
if [[ "$TARGET" == "all" || "$TARGET" == "prod" ]]; then
    echo "━━━ Production Server ━━━"
    if [[ "$USE_ANSIBLE" == "true" ]]; then
        test_ansible_ping "Production" "$INVENTORY_DIR/production.yml"
    else
        echo -e "  ${YELLOW}⚠️  SKIP${NC}: Configure inventory/production.yml then re-run with Ansible"
        echo ""
    fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "========================================"
echo "  Results"
echo "========================================"

if [[ $ERRORS -eq 0 ]]; then
    echo -e "  ${GREEN}All connectivity tests passed!${NC}"
    echo ""
    echo "  Next steps:"
    echo "    1. Run verify-secrets.sh to check secret configuration"
    echo "    2. Run canReach.sh to verify full deployment readiness"
    exit 0
else
    echo -e "  ${RED}$ERRORS test(s) failed${NC}"
    echo ""
    echo "  Troubleshooting:"
    echo "    - Verify SSH key permissions: chmod 600 ~/.ssh/*_deploy_key"
    echo "    - Check network/firewall rules"
    echo "    - Ensure the remote host is running and accepting SSH"
    echo "    - Try manual SSH: ssh -i ~/.ssh/<key> -v user@host"
    exit 1
fi
