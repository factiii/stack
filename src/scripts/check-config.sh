#!/bin/bash

# Server-side script to check configs and regenerate docker-compose.yml and nginx.conf
# This script scans ~/infrastructure/configs/ for all repo configs and merges them

set -e

INFRA_DIR="${INFRA_DIR:-$HOME/infrastructure}"
CONFIGS_DIR="${INFRA_DIR}/configs"
SCRIPTS_DIR="${INFRA_DIR}/scripts"
COMPOSE_FILE="${INFRA_DIR}/docker-compose.yml"
NGINX_DIR="${INFRA_DIR}/nginx"
NGINX_CONF="${NGINX_DIR}/nginx.conf"

echo "🔍 Checking infrastructure configurations..."
echo "   Configs directory: ${CONFIGS_DIR}"
echo "   Infrastructure directory: ${INFRA_DIR}"

# Check if configs directory exists
if [ ! -d "$CONFIGS_DIR" ]; then
    echo "⚠️  Configs directory not found: ${CONFIGS_DIR}"
    echo "   Creating directory..."
    mkdir -p "$CONFIGS_DIR"
    echo "✅ Created configs directory"
    echo "   Place repo config files (*.yml) in this directory"
    exit 0
fi

# Count config files
CONFIG_COUNT=$(find "$CONFIGS_DIR" -name "*.yml" -o -name "*.yaml" | wc -l | tr -d ' ')

if [ "$CONFIG_COUNT" -eq 0 ]; then
    echo "⚠️  No config files found in ${CONFIGS_DIR}"
    echo "   Place repo config files (*.yml) in this directory"
    exit 0
fi

echo "📦 Found ${CONFIG_COUNT} config file(s)"

# Ensure directories exist
mkdir -p "$NGINX_DIR" "$SCRIPTS_DIR"

# Check if Node.js is available (for running generators)
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js to use this script."
    exit 1
fi

# Check if generators are available
# They should be copied from the package to ~/infrastructure/scripts/
GENERATOR_DIR="${SCRIPTS_DIR}/generators"

if [ ! -d "$GENERATOR_DIR" ]; then
    echo "⚠️  Generators not found. Creating basic generator script..."
    
    # Create a simple Node.js script that uses the package generators
    # In practice, these would be copied from the npm package
    cat > "${SCRIPTS_DIR}/generate.js" << 'EOF'
const fs = require('fs');
const path = require('path');

// Simple inline generators (in production, these would be imported from the package)
// For now, we'll use a basic implementation

const CONFIGS_DIR = process.argv[2] || path.join(__dirname, '../configs');
const COMPOSE_FILE = process.argv[3] || path.join(__dirname, '../docker-compose.yml');
const NGINX_CONF = process.argv[4] || path.join(__dirname, '../nginx/nginx.conf');

console.log('Generating configs from:', CONFIGS_DIR);

// This is a placeholder - in production, use the actual generators from the package
console.log('✅ Config generation would happen here');
console.log('   In production, this would use the npm package generators');
EOF
    chmod +x "${SCRIPTS_DIR}/generate.js"
fi

# Try to use generators from scripts/generators (copied by deployment)
GENERATORS_DIR="${SCRIPTS_DIR}/generators"

if [ -d "$GENERATORS_DIR" ] && [ -f "${GENERATORS_DIR}/generate-compose.js" ]; then
    echo "📝 Using generators from ${GENERATORS_DIR}..."
    cd "$INFRA_DIR"
    node -e "
        const generateCompose = require('${GENERATORS_DIR}/generate-compose.js');
        const generateNginx = require('${GENERATORS_DIR}/generate-nginx.js');
        generateCompose('${CONFIGS_DIR}', '${COMPOSE_FILE}');
        generateNginx('${CONFIGS_DIR}', '${NGINX_CONF}');
    " || {
        echo "❌ Generator execution failed"
        exit 1
    }
else
    echo "⚠️  Generators not found in ${GENERATORS_DIR}"
    echo "   They should be copied during deployment."
    echo "   Checking for package in node_modules..."
    
    # Try to find package in node_modules
    PACKAGE_GENERATORS=""
    if [ -d "${INFRA_DIR}/node_modules/@yourorg/infrastructure" ]; then
        PACKAGE_GENERATORS="${INFRA_DIR}/node_modules/@yourorg/infrastructure/src/generators"
    elif [ -d "${INFRA_DIR}/node_modules/infrastructure" ]; then
        PACKAGE_GENERATORS="${INFRA_DIR}/node_modules/infrastructure/src/generators"
    fi
    
    if [ -n "$PACKAGE_GENERATORS" ] && [ -f "${PACKAGE_GENERATORS}/generate-compose.js" ]; then
        echo "📝 Using package generators from node_modules..."
        cd "$INFRA_DIR"
        node -e "
            const generateCompose = require('${PACKAGE_GENERATORS}/generate-compose.js');
            const generateNginx = require('${PACKAGE_GENERATORS}/generate-nginx.js');
            generateCompose('${CONFIGS_DIR}', '${COMPOSE_FILE}');
            generateNginx('${CONFIGS_DIR}', '${NGINX_CONF}');
        " || {
            echo "❌ Generator execution failed"
            exit 1
        }
    else
        echo "❌ No generators available. Cannot regenerate configs."
        echo "   Please ensure generators are copied to ${GENERATORS_DIR}/ during deployment"
        exit 1
    fi
fi

# Validate generated files
if [ ! -f "$COMPOSE_FILE" ]; then
    echo "❌ docker-compose.yml not generated"
    exit 1
fi

if [ ! -f "$NGINX_CONF" ]; then
    echo "❌ nginx.conf not generated"
    exit 1
fi

echo "✅ Generated docker-compose.yml and nginx.conf"

# Validate nginx config
if command -v docker &> /dev/null; then
    echo "🔍 Validating nginx configuration..."
    docker run --rm -v "${NGINX_DIR}:/etc/nginx:ro" nginx:alpine nginx -t || {
        echo "⚠️  Nginx config validation failed"
    }
fi

# Reload nginx if running
if command -v docker &> /dev/null && docker ps | grep -q infrastructure_nginx; then
    echo "🔄 Reloading nginx..."
    docker exec infrastructure_nginx nginx -s reload || {
        echo "⚠️  Failed to reload nginx. You may need to restart the container."
    }
fi

echo ""
echo "✅ Configuration check complete!"
echo "   docker-compose.yml: ${COMPOSE_FILE}"
echo "   nginx.conf: ${NGINX_CONF}"
echo ""
echo "📋 Next steps:"
echo "   1. Review the generated files"
echo "   2. Run: docker compose up -d (to start/update services)"


