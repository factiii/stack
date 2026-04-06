#!/usr/bin/env bash
set -e

echo "=== @factiii/auth development environment ==="
echo ""

# Check for Docker
if ! command -v docker &> /dev/null; then
  echo "Error: Docker is required but not installed."
  echo "Install Docker: https://docs.docker.com/get-docker/"
  exit 1
fi

# Check for pnpm
if ! command -v pnpm &> /dev/null; then
  echo "Error: pnpm is required but not installed."
  echo "Install pnpm: npm install -g pnpm"
  exit 1
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "[1/5] Installing dependencies..."
  pnpm install
else
  echo "[1/5] Dependencies already installed"
fi

# Start database
echo "[2/5] Starting PostgreSQL database..."
docker compose -f e2e/docker-compose.yml up -d --wait

# Run migrations
echo "[3/5] Running database migrations..."
pnpm prisma generate --schema=e2e/server/schema.prisma --config=e2e/server/prisma.config.ts
pnpm prisma migrate reset --schema=e2e/server/schema.prisma --config=e2e/server/prisma.config.ts --force

# Seed database
echo "[4/5] Seeding test data..."
pnpm tsx e2e/seed.ts

# Start servers
echo "[5/5] Starting servers..."
echo ""
echo "  Test client: http://localhost:3456"
echo "  API server:  http://localhost:3457"
echo ""
echo "  Test accounts (password: password123):"
echo "    testuser / test@example.com"
echo "    adminuser / admin@example.com"
echo "    twofa_user / twofa@example.com (2FA enabled)"
echo ""
echo "  Press Ctrl+C to stop"
echo ""

# Run both servers in parallel — kill both on exit
trap 'kill 0' EXIT
pnpm tsx e2e/server/index.ts &
pnpm vite --config e2e/app/vite.config.ts &
wait
