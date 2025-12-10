#!/usr/bin/env node
/**
 * ============================================================================
 * LEGACY SCRIPT - For backward compatibility with centralized approach
 * ============================================================================
 * This script is part of the legacy centralized infrastructure-config.yml
 * approach. For new repositories, use the decentralized approach with
 * the npm package CLI commands (npx core check-config, etc.)
 * ============================================================================
 * 
 * Generate docker-compose.yml and nginx.conf from infrastructure-config.yml
 * 
 * This script reads the infrastructure config and generates:
 *   - docker-compose.yml: Service definitions pulling from ECR
 *   - nginx/nginx.conf: Reverse proxy configuration
 * 
 * Usage: node scripts/generate-all.js [--config path/to/config.yml]
 * 
 * Environment variables:
 *   ECR_REGISTRY: ECR registry URL (e.g., 123456789.dkr.ecr.us-east-1.amazonaws.com)
 *   ECR_REPOSITORY: ECR repository name (e.g., apps)
 * 
 * No external dependencies required.
 */

const fs = require('fs');
const path = require('path');

// Paths
const ROOT_DIR = path.join(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(ROOT_DIR, 'infrastructure-config.yml');
const DOCKER_COMPOSE_PATH = path.join(ROOT_DIR, 'docker-compose.yml');
const NGINX_CONFIG_PATH = path.join(ROOT_DIR, 'nginx', 'nginx.conf');

// Parse command line args
const args = process.argv.slice(2);
let configPath = DEFAULT_CONFIG_PATH;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' && args[i + 1]) {
    configPath = args[i + 1];
  }
}

// Simple YAML parser for our specific config format
function parseSimpleYaml(content) {
  const config = { servers: {} };
  const lines = content.split('\n');
  
  let currentServer = null;
  let currentRepo = null;
  let inRepos = false;
  
  for (const line of lines) {
    // Strip inline comments (but not # in strings)
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    // Remove inline comments (simple approach - split on # and take first part)
    const commentIndex = trimmed.indexOf('  #');
    if (commentIndex > 0) {
      trimmed = trimmed.substring(0, commentIndex).trim();
    }
    
    const indent = line.search(/\S/);
    
    // Top-level keys
    if (indent === 0) {
      if (trimmed === 'servers:') {
        // servers block starts
      } else if (trimmed.startsWith('ssl_email:')) {
        config.ssl_email = trimmed.split(':').slice(1).join(':').trim();
      }
      continue;
    }
    
    // Server names (indent 2)
    if (indent === 2 && trimmed.endsWith(':') && !trimmed.includes(' ')) {
      currentServer = trimmed.slice(0, -1);
      config.servers[currentServer] = { repos: [] };
      inRepos = false;
      continue;
    }
    
    // Server properties (indent 4)
    if (indent === 4 && currentServer) {
      if (trimmed.startsWith('ssh_key_secret:')) {
        config.servers[currentServer].ssh_key_secret = trimmed.split(':').slice(1).join(':').trim();
      } else if (trimmed.startsWith('host:')) {
        config.servers[currentServer].host = trimmed.split(':').slice(1).join(':').trim();
      } else if (trimmed.startsWith('user:')) {
        config.servers[currentServer].user = trimmed.split(':').slice(1).join(':').trim();
      } else if (trimmed === 'repos:') {
        inRepos = true;
      }
      continue;
    }
    
    // Repo list items (indent 6, starts with -)
    if (indent === 6 && inRepos && trimmed.startsWith('- name:')) {
      currentRepo = { name: trimmed.replace('- name:', '').trim() };
      config.servers[currentServer].repos.push(currentRepo);
      continue;
    }
    
    // Repo properties (indent 8)
    if (indent === 8 && currentRepo) {
      if (trimmed.startsWith('environment:')) {
        currentRepo.environment = trimmed.split(':').slice(1).join(':').trim();
      } else if (trimmed.startsWith('domain:')) {
        currentRepo.domain = trimmed.split(':').slice(1).join(':').trim();
      }
    }
  }
  
  return config;
}

// Extract unique services from config
function extractServices(config) {
  const services = new Map(); // key: "repo-env", value: service info
  
  for (const [serverName, serverConfig] of Object.entries(config.servers || {})) {
    for (const repo of serverConfig.repos || []) {
      const serviceKey = `${repo.name}-${repo.environment}`;
      if (!services.has(serviceKey)) {
        if (!repo.domain) {
          throw new Error(`Missing required 'domain' field for ${repo.name} (${repo.environment})`);
        }
        services.set(serviceKey, {
          name: repo.name,
          environment: repo.environment,
          domain: repo.domain,
          servers: [serverName]
        });
      } else {
        services.get(serviceKey).servers.push(serverName);
      }
    }
  }
  
  return services;
}

// Assign ports to services (starting at 3001)
function assignPorts(services) {
  const portMap = new Map();
  let nextPort = 3001;
  
  for (const [serviceKey, service] of services) {
    portMap.set(serviceKey, nextPort++);
  }
  
  return portMap;
}

// Generate docker-compose.yml
function generateDockerCompose(config, services, portMap) {
  const ecrRegistry = process.env.ECR_REGISTRY || '${ECR_REGISTRY}';
  const ecrRepo = process.env.ECR_REPOSITORY || '${ECR_REPOSITORY}';
  
  let compose = `# Auto-generated by scripts/generate-all.js
# Do not edit directly - modify infrastructure-config.yml and re-run generator

services:
  # Nginx Reverse Proxy
  nginx:
    image: nginx:alpine
    container_name: infrastructure_nginx
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
      - certbot-www:/var/www/certbot:ro
      - certbot-conf:/etc/letsencrypt:ro
    networks:
      - infrastructure_network
    restart: unless-stopped
    depends_on:
      - certbot
    healthcheck:
      test: ["CMD", "nginx", "-t"]
      interval: 30s
      timeout: 10s
      retries: 3

  # Certbot for SSL
  certbot:
    image: certbot/certbot
    container_name: infrastructure_certbot
    volumes:
      - certbot-www:/var/www/certbot
      - certbot-conf:/etc/letsencrypt
    networks:
      - infrastructure_network
    command: certonly --webroot --webroot-path=/var/www/certbot --email ${config.ssl_email} --agree-tos --no-eff-email${generateCertbotDomains(services)}
    restart: "no"

  # Postgres Staging Database
  postgres-staging:
    image: postgres:15-alpine
    container_name: infrastructure_postgres_staging
    ports:
      - "5432:5432"
    environment:
      POSTGRES_USER: \${POSTGRES_USER:-postgres}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:-postgres}
      POSTGRES_DB: \${POSTGRES_DB:-postgres}
    volumes:
      - postgres-staging-data:/var/lib/postgresql/data
    networks:
      - infrastructure_network
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${POSTGRES_USER:-postgres}"]
      interval: 10s
      timeout: 5s
      retries: 5

`;

  // Generate service entries
  for (const [serviceKey, service] of services) {
    const port = portMap.get(serviceKey);
    const containerName = serviceKey;
    const imageTag = `${service.name}-${service.environment === 'staging' ? 'main' : 'main'}-latest`;
    const isStaging = service.environment === 'staging';
    
    compose += `  # ${service.name} - ${service.environment}
  ${serviceKey}:
    image: ${ecrRegistry}/${ecrRepo}:${imageTag}
    container_name: ${containerName}
    environment:
      - NODE_ENV=${service.environment === 'staging' ? 'staging' : 'production'}
    env_file:
      - ./secrets/${serviceKey}.env
    networks:
      - infrastructure_network
    restart: unless-stopped
${isStaging ? `    depends_on:
      postgres-staging:
        condition: service_healthy
` : ''}    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:${port}/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s

`;
  }

  compose += `volumes:
  postgres-staging-data:
  certbot-www:
  certbot-conf:

networks:
  infrastructure_network:
    driver: bridge
`;

  return compose;
}

// Generate certbot domains string
function generateCertbotDomains(services) {
  const domains = new Set();
  for (const [, service] of services) {
    domains.add(service.domain);
  }
  return Array.from(domains).map(d => ` -d ${d}`).join('');
}

// Generate nginx.conf
function generateNginxConfig(config, services, portMap) {
  let nginx = `# Auto-generated by scripts/generate-all.js
# Do not edit directly - modify infrastructure-config.yml and re-run generator

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
  for (const [serviceKey, service] of services) {
    const port = portMap.get(serviceKey);
    
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
            proxy_pass http://${serviceKey}:${port};
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

  return nginx;
}

// Main
function main() {
  console.log('🔧 Generating infrastructure files...\n');

  // Load config
  if (!fs.existsSync(configPath)) {
    console.error(`❌ Config not found: ${configPath}`);
    process.exit(1);
  }
  
  const configContent = fs.readFileSync(configPath, 'utf8');
  const config = parseSimpleYaml(configContent);
  console.log('✅ Loaded infrastructure-config.yml');
  console.log(`   SSL email: ${config.ssl_email || '(not set)'}`);
  console.log(`   Servers: ${Object.keys(config.servers).join(', ')}`);

  // Extract services
  const services = extractServices(config);
  console.log(`\n📦 Found ${services.size} services:`);
  for (const [key, service] of services) {
    console.log(`   - ${key} → ${service.domain}`);
  }

  // Assign ports
  const portMap = assignPorts(services);
  console.log('\n🔌 Port assignments:');
  for (const [key, port] of portMap) {
    console.log(`   - ${key}: ${port}`);
  }

  // Generate docker-compose.yml
  const dockerCompose = generateDockerCompose(config, services, portMap);
  fs.writeFileSync(DOCKER_COMPOSE_PATH, dockerCompose);
  console.log(`\n✅ Generated: ${DOCKER_COMPOSE_PATH}`);

  // Generate nginx.conf
  fs.mkdirSync(path.dirname(NGINX_CONFIG_PATH), { recursive: true });
  const nginxConfig = generateNginxConfig(config, services, portMap);
  fs.writeFileSync(NGINX_CONFIG_PATH, nginxConfig);
  console.log(`✅ Generated: ${NGINX_CONFIG_PATH}`);

  console.log('\n🎉 All files generated successfully!');
  console.log('\nNext steps:');
  console.log('1. Ensure secrets/*.env files exist for each service');
  console.log('2. Run: docker compose up -d');
}

main();

