#!/bin/bash

# Setup infrastructure on target server
# Usage: ./scripts/setup-infrastructure.sh [server-name]
# If server-name not provided, sets up for all servers in config

set -e

INFRASTRUCTURE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER_NAME="$1"

# Source the parse script
source "${INFRASTRUCTURE_ROOT}/scripts/parse-infrastructure-config.sh"

setup_server() {
    local server="$1"
    
    echo "🔧 Setting up infrastructure on $server..."
    
    # Generate nginx config
    echo "📝 Generating nginx configuration..."
    "${INFRASTRUCTURE_ROOT}/scripts/generate-nginx-config.sh"
    
    # Generate certbot domains
    echo "📝 Generating certbot domain list..."
    DOMAINS=$("${INFRASTRUCTURE_ROOT}/scripts/generate-certbot-domains.sh")
    SSL_EMAIL=$(get_ssl_email)
    
    # Update docker-compose.yml certbot command (if needed)
    # This would update the certbot service command with new domains
    
    # Start Docker Compose services
    echo "🐳 Starting Docker Compose services..."
    cd "$INFRASTRUCTURE_ROOT"
    
    # Start base services (nginx, certbot, postgres-staging)
    docker-compose up -d nginx postgres-staging || true
    
    # Run certbot if domains are configured
    if [ -n "$DOMAINS" ]; then
        echo "🔒 Running certbot for domains: $DOMAINS"
        docker-compose run --rm certbot certonly \
            --webroot \
            --webroot-path=/var/www/certbot \
            --email "$SSL_EMAIL" \
            --agree-tos \
            --no-eff-email \
            $(echo "$DOMAINS" | sed 's/\([^ ]*\)/-d \1/g') || echo "Warning: Certbot may have failed. Check logs."
    fi
    
    # Reload nginx
    echo "🔄 Reloading nginx..."
    docker-compose exec nginx nginx -s reload || docker-compose restart nginx || true
    
    echo "✅ Infrastructure setup complete for $server"
}

if [ -n "$SERVER_NAME" ]; then
    setup_server "$SERVER_NAME"
else
    # Setup all servers
    if command -v yq &> /dev/null; then
        SERVERS=$(yq eval '.servers | keys | .[]' "${INFRASTRUCTURE_ROOT}/infrastructure-config.yml")
        for server in $SERVERS; do
            setup_server "$server"
        done
    else
        echo "Error: yq required to setup all servers, or specify server name" >&2
        exit 1
    fi
fi
