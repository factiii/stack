#!/usr/bin/env bash
# =============================================================================
# mac-scan.sh - Direct SSH scan on Mac build server
# =============================================================================
#
# FIRST CONVERSION: This is the proof-of-concept script that replaces the
# factiii-scan.yml GitHub workflow for Mac environments.
#
# Before (GitHub workflow):
#   1. User runs `npx factiii scan`
#   2. CLI triggers GitHub Actions factiii-scan.yml
#   3. Workflow checks out code, sets up SSH key from GitHub Secrets
#   4. Workflow SSHs to Mac: GITHUB_ACTIONS=true npx factiii scan --staging
#   5. Results appear in GitHub Actions logs
#
# After (this script):
#   1. User runs `bash ansible/scripts/mac-scan.sh`
#   2. Script SSHs directly to Mac using local deploy key
#   3. Runs scan command on Mac
#   4. Results appear immediately in terminal
#
# Prerequisites:
#   - Mac SSH key at ~/.ssh/mac_deploy_key (from Ansible Vault)
#   - Mac inventory configured (ansible/inventory/mac.yml)
#   - factiii.yml in the app repo with Mac environment
#
# Usage:
#   ./mac-scan.sh                    # Scan using inventory defaults
#   ./mac-scan.sh --stage staging    # Explicit stage (default: staging)
#
# Exit codes:
#   0 - Scan completed successfully
#   1 - Scan failed or connectivity error
# =============================================================================

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INVENTORY_FILE="$(dirname "$SCRIPT_DIR")/inventory/mac.yml"
STAGE="staging"
SSH_KEY="$HOME/.ssh/mac_deploy_key"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
while [[ $# -gt 0 ]]; do
    case $1 in
        --stage) STAGE="$2"; shift 2 ;;
        --key) SSH_KEY="$2"; shift 2 ;;
        --inventory) INVENTORY_FILE="$2"; shift 2 ;;
        --help|-h)
            echo "Usage: $0 [--stage staging|prod] [--key path] [--inventory path]"
            echo ""
            echo "Runs Factiii scan on Mac build server via direct SSH."
            echo "Replaces the factiii-scan.yml GitHub workflow for Mac."
            echo ""
            echo "Options:"
            echo "  --stage      Stage to scan (default: staging)"
            echo "  --key        SSH key path (default: ~/.ssh/mac_deploy_key)"
            echo "  --inventory  Inventory file (default: ansible/inventory/mac.yml)"
            exit 0
            ;;
        *) shift ;;
    esac
done

# ---------------------------------------------------------------------------
# Validate prerequisites
# ---------------------------------------------------------------------------
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Mac Scan (Direct SSH)${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo ""

# Check SSH key
if [[ ! -f "$SSH_KEY" ]]; then
    echo -e "${RED}❌ SSH key not found: $SSH_KEY${NC}"
    echo "   Run: npx factiii secrets write-ssh-keys"
    echo "   Or:  ssh-keygen -t ed25519 -f $SSH_KEY"
    exit 1
fi
echo -e "  ${GREEN}✅${NC} SSH key: $SSH_KEY"

# Check inventory
if [[ ! -f "$INVENTORY_FILE" ]]; then
    echo -e "${RED}❌ Inventory not found: $INVENTORY_FILE${NC}"
    echo "   Configure ansible/inventory/mac.yml with your Mac details."
    exit 1
fi

# Check for CHANGEME placeholders
if grep -q "CHANGEME" "$INVENTORY_FILE"; then
    echo -e "${RED}❌ Inventory has CHANGEME placeholders${NC}"
    echo "   Edit $INVENTORY_FILE and replace all CHANGEME values."
    exit 1
fi
echo -e "  ${GREEN}✅${NC} Inventory: $INVENTORY_FILE"

# Parse host and user from inventory
HOST=$(grep "ansible_host:" "$INVENTORY_FILE" | head -1 | awk '{print $2}' | tr -d '"')
USER=$(grep "ansible_user:" "$INVENTORY_FILE" | head -1 | awk '{print $2}' | tr -d '"')
REPO_PATH=$(grep "factiii_repo_path:" "$INVENTORY_FILE" | head -1 | awk '{print $2}' | tr -d '"')

if [[ -z "$HOST" || -z "$USER" ]]; then
    echo -e "${RED}❌ Cannot parse host/user from inventory${NC}"
    exit 1
fi
echo -e "  ${GREEN}✅${NC} Target: ${USER}@${HOST}"
echo -e "  ${GREEN}✅${NC} Stage: ${STAGE}"
echo ""

# ---------------------------------------------------------------------------
# Test connectivity
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Testing SSH connectivity...${NC}"

if ! ssh -i "$SSH_KEY" \
    -o StrictHostKeyChecking=no \
    -o ConnectTimeout=10 \
    -o BatchMode=yes \
    "${USER}@${HOST}" \
    "echo ok" &>/dev/null; then
    echo -e "${RED}❌ Cannot connect to ${USER}@${HOST}${NC}"
    echo "   Check: network, firewall, SSH key permissions (chmod 600)"
    exit 1
fi
echo -e "  ${GREEN}✅${NC} SSH connection successful"
echo ""

# ---------------------------------------------------------------------------
# Bootstrap check (ensure Node.js is available)
# ---------------------------------------------------------------------------
echo -e "${YELLOW}Checking Node.js on Mac...${NC}"

NODE_VERSION=$(ssh -i "$SSH_KEY" \
    -o StrictHostKeyChecking=no \
    -o ConnectTimeout=10 \
    "${USER}@${HOST}" \
    "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\" && node --version 2>/dev/null || echo 'NOT_FOUND'" \
)

if [[ "$NODE_VERSION" == "NOT_FOUND" ]]; then
    echo -e "${YELLOW}⚠️  Node.js not found, attempting install via Homebrew...${NC}"
    ssh -i "$SSH_KEY" \
        -o StrictHostKeyChecking=no \
        "${USER}@${HOST}" \
        "export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\" && brew install node" \
    || {
        echo -e "${RED}❌ Failed to install Node.js on Mac${NC}"
        exit 1
    }
else
    echo -e "  ${GREEN}✅${NC} Node.js ${NODE_VERSION}"
fi
echo ""

# ---------------------------------------------------------------------------
# Run scan
# ---------------------------------------------------------------------------
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  Running: npx factiii scan --${STAGE}${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
echo ""

# Build the remote command
# - Export Homebrew PATH for macOS tools
# - cd to the repo directory
# - Run the scan with the specified stage
REMOTE_CMD="export PATH=\"/opt/homebrew/bin:/usr/local/bin:\$PATH\" && cd ${REPO_PATH} && npx factiii scan --${STAGE}"

# Execute via SSH with keepalive for long-running scans
ssh -i "$SSH_KEY" \
    -o StrictHostKeyChecking=no \
    -o ConnectTimeout=10 \
    -o ServerAliveInterval=60 \
    -o ServerAliveCountMax=5 \
    "${USER}@${HOST}" \
    "$REMOTE_CMD"

EXIT_CODE=$?

echo ""
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"
if [[ $EXIT_CODE -eq 0 ]]; then
    echo -e "  ${GREEN}✅ Mac scan completed successfully${NC}"
else
    echo -e "  ${RED}❌ Mac scan failed (exit code: $EXIT_CODE)${NC}"
fi
echo -e "${CYAN}═══════════════════════════════════════════════════${NC}"

exit $EXIT_CODE
