const mergeConfigs = require('./merge-configs');

/**
 * Generate docker-compose.yml from merged configs
 * @param {string} configsDir - Directory containing individual repo configs
 * @param {string} outputPath - Path to write docker-compose.yml
 */
function generateCompose(configsDir, outputPath) {
  const merged = mergeConfigs(configsDir);
  const { services, sslEmail, ecrRegistry, ecrRepository } = merged;

  let compose = `# Auto-generated from configs in ${configsDir}
# Do not edit directly - modify individual repo configs and regenerate

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
    command: certonly --webroot --webroot-path=/var/www/certbot --email ${sslEmail} --agree-tos --no-eff-email${generateCertbotDomains(services)}
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
  for (const service of services) {
    const imageTag = `${service.name}-main-latest`;
    const isStaging = service.environment === 'staging';
    // Always include env_file - env files are named using service.key format: ${repo-name}-${env}.env
    const envFile = `      - ./${service.key}.env`;

    compose += `  # ${service.name} - ${service.environment}
  ${service.key}:
    image: ${ecrRegistry}/${ecrRepository}:${imageTag}
    container_name: ${service.key}
    environment:
      - NODE_ENV=${service.environment === 'staging' ? 'staging' : 'production'}
    env_file:
${envFile}
    networks:
      - infrastructure_network
    restart: unless-stopped
${isStaging ? `    depends_on:
      postgres-staging:
        condition: service_healthy
` : ''}    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:${service.port}${service.healthCheck}"]
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

  // Write file
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, compose);
  
  console.log(`✅ Generated: ${outputPath}`);
}

function generateCertbotDomains(services) {
  const domains = [...new Set(services.map(s => s.domain))];
  return domains.map(d => ` -d ${d}`).join('');
}

module.exports = generateCompose;


