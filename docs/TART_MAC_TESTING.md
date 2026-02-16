# Testing Mac Server Mode Scan/Fix with Tart

This guide explains how to test the Mac host scanfix (server-mode addon) using a Tart macOS VM. Tart runs macOS VMs on Apple Silicon via Virtualization.framework.

## Prerequisites

- **Apple Silicon Mac** (M1/M2/M3)
- **macOS 13 (Ventura) or later**
- **Tart** installed: `brew install cirruslabs/cli/tart`

## 1. Create and Run a Mac VM

```bash
# Clone a pre-built macOS image (~25 GB first time)
tart clone ghcr.io/cirruslabs/macos-sequoia-base:latest sequoia-base

# Run the VM
tart run sequoia-base
```

**Default credentials:** `admin` / `admin`

## 2. Get the VM IP and SSH In

In a **separate terminal** (VM keeps running):

```bash
# Get VM IP (may take 30–60 sec after boot)
tart ip sequoia-base

# SSH into the VM
ssh admin@$(tart ip sequoia-base)
# Password: admin
```

## 3. Mount the Core Repo (from host)

Stop the VM (`tart stop sequoia-base`), then run with a directory mount:

```bash
tart run --dir=core:$(pwd) sequoia-base
```

Inside the VM, the repo is at: `/Volumes/My Shared Files/core`

## 4. Test Scan/Fix Inside the VM

SSH into the running VM and run factiii:

```bash
ssh admin@$(tart ip sequoia-base)
# or, with sshpass for non-interactive: sshpass -p admin ssh -o StrictHostKeyChecking=no admin@$(tart ip sequoia-base)

cd "/Volumes/My Shared Files/core"

# Install deps and build
pnpm install
pnpm build

# Use an app repo with factiii.yml (staging + server: mac)
# Option A: Mount your app repo too
#   tart run --dir=core:$(pwd) --dir=app:/path/to/your-app sequoia-base
#   cd "/Volumes/My Shared Files/app"
#   pnpm link "/Volumes/My Shared Files/core"

# Option B: Use core's factiii.yml if it has staging with server: mac
cd "/Volumes/My Shared Files/core"
pnpm link .
npx factiii scan --staging
npx factiii fix --staging
```

## 5. One-Liner Test (from host)

Run scan inside the VM without an interactive SSH session:

```bash
brew install cirruslabs/cli/sshpass  # if needed

sshpass -p admin ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  admin@$(tart ip sequoia-base) \
  'cd "/Volumes/My Shared Files/core" && pnpm install && pnpm build && npx factiii scan --staging'
```

(Ensure the VM was started with `--dir=core:...` so the repo is mounted.)

## 6. What the Mac Host Fixes Check

| Fix ID | What it does |
|--------|--------------|
| `macos-sleep-enabled` | Sleep not disabled → `pmset sleep 0 disksleep 0 displaysleep 0` |
| `macos-screensaver-enabled` | Screensaver on → `defaults write com.apple.screensaver idleTime 0` |
| `macos-ssh-disabled` | Remote Login off → `systemsetup -setremotelogin on` |
| `macos-app-nap-enabled` | App Nap on → `defaults write NSGlobalDomain NSAppSleepDisabled -bool YES` |
| `macos-autorestart-disabled` | No auto-restart on power loss → `pmset autorestart 1` |
| `macos-disablesleep-disabled` | System sleep not fully disabled → `pmset disablesleep 1` |
| `macos-autologin-disabled` | Auto-login not set → manual (System Settings or plist) |

## 7. Creating a Custom Tart Image (optional)

To bake a Mac image with factiii and your app already set up:

1. Follow [Tart's create from IPSW](https://tart.run/quick-start/#creating-macos-vm-images) or clone a base image.
2. Boot, complete setup, create `admin` user.
3. In the VM:
   - `sudo visudo` → add `admin ALL=(ALL) NOPASSWD: ALL`
   - Disable Screen Saver, Lock Screen password
   - Enable Remote Login (SSH)
   - Enable Auto-Login: Users & Groups → Login Options → Automatic login → admin
4. Install Node, pnpm, mount core, link, etc.
5. Stop the VM and push: `tart push my-image ghcr.io/your-org/mac-host:latest`

Then you can `tart clone` and `tart run` that image for faster tests.

## Troubleshooting

- **"tart ip" returns nothing:** VM may still be booting. Wait 1–2 minutes.
- **Mount not visible:** Ensure guest is macOS 13+; path is `/Volumes/My Shared Files/<mount-name>`.
- **sudo prompts:** Use NOPASSWD in sudoers or enter password when prompted.
- **server-mode not loading:** `factiii.yml` must have `staging` (or `prod`) with `server: mac` and `server_mode` not set to `false`.
