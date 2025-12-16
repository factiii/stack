#!/bin/bash

# ============================================================================
# LEGACY SCRIPT - For backward compatibility with centralized approach
# ============================================================================
# This script is part of the legacy centralized factiii.yml
# approach. For new repositories, use the decentralized approach with
# the npm package CLI commands (npx factiii check-config, etc.)
# ============================================================================
#
# Generate nginx.conf from factiii.yml
# Usage: ./scripts/generate-nginx-config.sh [output-file]
# If output-file not specified, outputs to nginx/nginx.conf

set -e

INFRASTRUCTURE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="${INFRASTRUCTURE_ROOT}/factiii.yml"
OUTPUT_FILE="${1:-${INFRASTRUCTURE_ROOT}/nginx/nginx.conf}"

# Source the parse script
source "${INFRASTRUCTURE_ROOT}/scripts/parse-infrastructure-config.sh"

# Function to get port for a repo (from docker-compose.yml or default)
get_repo_port() {
    local repo_name="$1"
    # Default ports based on existing setup
    case "$repo_name" in
        factiii) echo "3001" ;;
        chop-shop) echo "5001" ;;
        link3d) echo "3003" ;;
        tap-track) echo "3005" ;;
        *) echo "5001" ;;
    esac
}

# Check for yq
if ! command -v yq &> /dev/null; then
    echo "Error: yq is required to generate nginx config" >&2
    echo "Install with: brew install yq (macOS) or sudo snap install yq (Linux)" >&2
    exit 1
fi

# Collect unique domain/service combinations
declare -A DOMAINS_SEEN

# Generate nginx config
{
    cat <<EOF
user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /var/run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '\$remote_addr - \$remote_user [\$time_local] "\$request" '
                    '\$status \$body_bytes_sent "\$http_referer" '
                    '"\$http_user_agent" "\$http_x_forwarded_for"';

    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    client_max_body_size 20M;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml text/javascript application/json application/javascript application/xml+rss application/rss+xml font/truetype font/opentype application/vnd.ms-fontobject image/svg+xml;

    # Rate limiting
    limit_req_zone \$binary_remote_addr zone=api_limit:10m rate=10r/s;

    # HTTP server - redirect to HTTPS and handle ACME challenges
    server {
        listen 80;
        server_name _;

        # ACME challenge for Let's Encrypt
        location /.well-known/acme-challenge/ {
            root /var/www/certbot;
        }

        # Redirect all other HTTP traffic to HTTPS
        location / {
            return 301 https://\$host\$request_uri;
        }
    }

EOF

    # Generate server blocks for each unique domain
    # Collect all unique repo/environment combinations with their explicit domains
    yq eval '.servers | to_entries | .[] | .key as $server | .value.repos[] | "\(.name)|\(.environment)|\($server)"' "$CONFIG_FILE" | sort -u | while IFS='|' read -r repo_name env server_name; do
        # Skip empty lines
        [ -z "$repo_name" ] && continue
        
        # Get explicit domain from config
        domain=$(get_domain "$repo_name" "$env" "$server_name" 2>/dev/null || echo "")
        if [ -z "$domain" ]; then
            echo "Warning: No domain found for $repo_name ($env) on $server_name, skipping" >&2
            continue
        fi
        
        # Skip if we've already generated this domain
        domain_key="${domain}"
        if [ -n "${DOMAINS_SEEN[$domain_key]:-}" ]; then
            continue
        fi
        DOMAINS_SEEN[$domain_key]=1
        
        port=$(get_repo_port "$repo_name")
        service_name="${repo_name}-${env}"
        
        cat <<EOF
    # ${repo_name^} - ${env^}
    server {
        listen 443 ssl http2;
        server_name ${domain};

        ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;
        ssl_prefer_server_ciphers on;

        # Security headers
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;

        location / {
            limit_req zone=api_limit burst=20 nodelay;
            proxy_pass http://${service_name}:${port};
            proxy_http_version 1.1;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host \$host;
            proxy_set_header X-Real-IP \$remote_addr;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_cache_bypass \$http_upgrade;
            proxy_read_timeout 300s;
            proxy_connect_timeout 75s;
        }
    }

EOF
    done

    echo "}"
} > "$OUTPUT_FILE"

echo "✅ Generated nginx config: $OUTPUT_FILE"
