#!/usr/bin/env bash
# Test Mac host scanfix inside Tart macOS VM
#
# Prerequisites:
#   - Apple Silicon Mac, tart installed (brew install cirruslabs/cli/tart)
#   - Tart VM: tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest sequoia-base
#
# Usage:
#   ./scripts/tart-mac-scanfix-test.sh [vm-name]
#   Default VM: sequoia-base
#
# Flow:
#   1. Start VM with core repo mounted (if not running)
#   2. SSH in, run: FACTIII_ON_SERVER=1 npx stack scan --staging
#   3. Run: FACTIII_ON_SERVER=1 npx stack fix --staging
#   4. Run scan again to verify
#
set -e

VM_NAME="${1:-sequoia-base}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CORE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Tart Mac Scanfix Test ==="
echo "VM: $VM_NAME"
echo "Core: $CORE_DIR"
echo ""

# Check tart is installed
if ! command -v tart &>/dev/null; then
  echo "ERROR: tart not found. Install: brew install cirruslabs/cli/tart"
  exit 1
fi

# Check VM exists
if ! tart list 2>/dev/null | grep -q "$VM_NAME"; then
  echo "ERROR: VM '$VM_NAME' not found. Run: tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest $VM_NAME"
  exit 1
fi

# Start VM with mount if not running
if ! tart list 2>/dev/null | grep "$VM_NAME" | grep -q "running"; then
  echo "Starting VM with core mounted..."
  tart run --dir=core:"$CORE_DIR" "$VM_NAME" &
  TART_PID=$!
  echo "Waiting for VM to boot (60s)..."
  sleep 60
else
  echo "VM already running. Ensure it was started with: tart run --dir=core:$CORE_DIR $VM_NAME"
  echo "If not, stop it (tart stop $VM_NAME) and re-run this script."
fi

# Get VM IP
echo "Getting VM IP..."
VM_IP=""
for i in {1..12}; do
  VM_IP=$(tart ip "$VM_NAME" 2>/dev/null || true)
  if [ -n "$VM_IP" ]; then
    break
  fi
  echo "  Waiting... ($i/12)"
  sleep 5
done

if [ -z "$VM_IP" ]; then
  echo "ERROR: Could not get VM IP. Is the VM running?"
  exit 1
fi
echo "VM IP: $VM_IP"

# Check sshpass for non-interactive auth (optional)
SSH_CMD="ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null admin@$VM_IP"
if command -v sshpass &>/dev/null; then
  SSH_CMD="sshpass -p admin ssh -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null admin@$VM_IP"
fi

REPO_PATH='/Volumes/My Shared Files/core'
RUN="cd $REPO_PATH && pnpm install && pnpm build"

echo ""
echo "=== Step 1: Scan (before fix) ==="
$SSH_CMD "env FACTIII_ON_SERVER=1 $RUN && npx stack scan --staging" || true

echo ""
echo "=== Step 2: Fix ==="
$SSH_CMD "env FACTIII_ON_SERVER=1 $RUN && npx stack fix --staging" || true

echo ""
echo "=== Step 3: Scan (after fix) ==="
$SSH_CMD "env FACTIII_ON_SERVER=1 $RUN && npx stack scan --staging" || true

echo ""
echo "=== Done ==="
echo "Notes:"
echo "  - Some pmset flags (womp, hibernatemode, standby) may not work in Tart VMs (virtual hardware)"
echo "  - Wake on LAN (womp) requires Ethernet and compatible hardware"
echo "  - Bluetooth disable is manual-only (risk of losing keyboard/mouse)"
echo "  - Auto-login requires reboot to take effect"
echo "  - File sharing disable is manual-only (may be intentionally enabled)"
