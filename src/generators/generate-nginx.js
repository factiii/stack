const mergeConfigs = require('./merge-configs');

/**
 * Generate nginx.conf from merged configs
 * @param {string} configsDir - Directory containing individual repo configs
 * @param {string} outputPath - Path to write nginx.conf
 */
function generateNginx(configsDir, outputPath) {
  const merged = mergeConfigs(configsDir);
  const { services } = merged;

  let nginx = `# Auto-generated from configs in ${configsDir}
# Do not edit directly - modify individual repo configs and regenerate

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

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

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
    limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;

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
            return 301 https://$host$request_uri;
        }
    }

`;

  // Generate server blocks for each service
  for (const service of services) {
    nginx += `    # ${service.name} - ${service.environment}
    server {
        listen 443 ssl http2;
        server_name ${service.domain};

        ssl_certificate /etc/letsencrypt/live/${service.domain}/fullchain.pem;
        ssl_certificate_key /etc/letsencrypt/live/${service.domain}/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        ssl_ciphers HIGH:!aNULL:!MD5;
        ssl_prefer_server_ciphers on;

        # Security headers
        add_header X-Frame-Options "SAMEORIGIN" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header X-XSS-Protection "1; mode=block" always;

        location / {
            limit_req zone=api_limit burst=20 nodelay;
            proxy_pass http://${service.key}:${service.port};
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_cache_bypass $http_upgrade;
            proxy_read_timeout 300s;
            proxy_connect_timeout 75s;
        }
    }

`;
  }

  nginx += `}
`;

  // Write file
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, nginx);
  
  console.log(`✅ Generated: ${outputPath}`);
}

module.exports = generateNginx;


