#!/usr/bin/env node

/**
 * Server-side script: generate-all.js
 *
 * Scans all repos in ~/.factiii/* and regenerates:
 * - docker-compose.yml (unified services from all repos)
 * - nginx.conf (routes for all domains)
 *
 * Run on server after git pull to sync deployed configs with source
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import type { FactiiiConfig, EnvironmentConfig } from '../types/index.js';

interface RepoInfo {
  name: string;
  path: string;
  configPath: string;
}

interface NginxRoute {
  domain: string;
  service: string;
  port: number;
}

interface AutoConfig {
  dockerfile?: string;
}

interface DockerComposeService {
  build?: {
    context: string;
    dockerfile: string;
  };
  image?: string;
  container_name?: string;
  restart?: string;
  networks?: string[];
  environment?: Record<string, string>;
  env_file?: string[];
  ports?: string[];
  expose?: string[];
  volumes?: string[];
}

interface DockerCompose {
  version: string;
  services: Record<string, DockerComposeService>;
  networks: Record<string, { driver: string }>;
}

/**
 * Get the factiii directory path
 * Uses FACTIII_DIR env var if set, otherwise ~/.factiii
 */
function getFactiiiDir(): string {
  return process.env.FACTIII_DIR ?? path.join(process.env.HOME ?? '/home/ubuntu', '.factiii');
}

/**
 * Scan ~/.factiii for repo directories
 */
export function scanRepos(): RepoInfo[] {
  const factiiiDir = getFactiiiDir();

  if (!fs.existsSync(factiiiDir)) {
    if (require.main === module) {
      console.error('❌ ~/.factiii directory not found');
      process.exit(1);
    }
    return [];
  }

  const entries = fs.readdirSync(factiiiDir);
  const repos: RepoInfo[] = [];

  for (const entry of entries) {
    const fullPath = path.join(factiiiDir, entry);
    const stat = fs.statSync(fullPath);

    // Skip non-directories and special directories
    if (!stat.isDirectory()) continue;
    if (entry === 'scripts' || entry === 'node_modules' || entry.startsWith('.')) continue;

    // Check if factiii.yml exists
    const configPath = path.join(fullPath, 'factiii.yml');
    if (fs.existsSync(configPath)) {
      repos.push({
        name: entry,
        path: fullPath,
        configPath,
      });
    }
  }

  return repos;
}

/**
 * Load configs from all repos
 */
export function loadConfigs(repos: RepoInfo[]): Record<string, FactiiiConfig> {
  const configs: Record<string, FactiiiConfig> = {};

  for (const repo of repos) {
    try {
      const content = fs.readFileSync(repo.configPath, 'utf8');
      const config = yaml.load(content) as FactiiiConfig | null;
      if (config) {
        configs[repo.name] = config;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`⚠️  Failed to load ${repo.name}/factiii.yml: ${errorMessage}`);
    }
  }

  return configs;
}

/**
 * Generate docker-compose.yml from all repos' configs
 */
export function generateDockerCompose(allConfigs: Record<string, FactiiiConfig>): number {
  const factiiiDir = getFactiiiDir();
  const compose: DockerCompose = {
    version: '3.8',
    services: {},
    networks: {
      factiii: {
        driver: 'bridge',
      },
    },
  };

  // Add nginx reverse proxy
  compose.services.nginx = {
    image: 'nginx:alpine',
    container_name: 'factiii_nginx',
    ports: ['80:80', '443:443'],
    volumes: ['./nginx.conf:/etc/nginx/nginx.conf:ro'],
    networks: ['factiii'],
    restart: 'unless-stopped',
  };

  // For each repo and each environment, create a service
  for (const [repoName, config] of Object.entries(allConfigs)) {
    if (!config.environments) continue;

    for (const [envName, envConfig] of Object.entries(config.environments)) {
      const serviceName = `${repoName}-${envName}`;
      const repoPath = path.join(factiiiDir, repoName);

      // Read dockerfile path from factiiiAuto.yml if exists
      let dockerfile = 'Dockerfile';
      const autoConfigPath = path.join(repoPath, 'factiiiAuto.yml');
      if (fs.existsSync(autoConfigPath)) {
        try {
          const autoConfig = yaml.load(fs.readFileSync(autoConfigPath, 'utf8')) as AutoConfig | null;
          if (autoConfig?.dockerfile) {
            dockerfile = autoConfig.dockerfile.split(' ')[0] ?? 'Dockerfile'; // Remove OVERRIDE if present
          }
        } catch {
          // Ignore errors
        }
      }

      compose.services[serviceName] = {
        build: {
          context: repoPath,
          dockerfile,
        },
        image: `${repoName}:${envName}`,
        container_name: serviceName,
        restart: 'unless-stopped',
        networks: ['factiii'],
        environment: {},
        env_file: [],
      };

      // Add env file if exists
      const envFile = path.join(
        repoPath,
        `.env.${envName === 'production' ? 'prod' : envName}`
      );
      if (fs.existsSync(envFile)) {
        compose.services[serviceName]!.env_file!.push(envFile);
      }

      // Add ports if configured
      const typedEnvConfig = envConfig as EnvironmentConfig & { port?: number };
      if (typedEnvConfig.port) {
        compose.services[serviceName]!.ports = [
          `${typedEnvConfig.port}:${typedEnvConfig.port}`,
        ];
      } else {
        // Expose port 3000 by default (internal only, nginx proxies)
        compose.services[serviceName]!.expose = ['3000'];
      }
    }
  }

  // Write docker-compose.yml
  const outputPath = path.join(getFactiiiDir(), 'docker-compose.yml');
  fs.writeFileSync(outputPath, yaml.dump(compose, { lineWidth: -1 }));

  return Object.keys(compose.services).length - 1; // Exclude nginx from count
}

/**
 * Generate nginx.conf from all repos' configs
 */
export function generateNginx(allConfigs: Record<string, FactiiiConfig>): number {
  const routes: NginxRoute[] = [];

  // Collect all domains from all repos
  for (const [repoName, config] of Object.entries(allConfigs)) {
    if (!config.environments) continue;

    for (const [envName, envConfig] of Object.entries(config.environments)) {
      const typedEnvConfig = envConfig as EnvironmentConfig & { port?: number };
      if (typedEnvConfig.domain) {
        routes.push({
          domain: typedEnvConfig.domain,
          service: `${repoName}-${envName}`,
          port: typedEnvConfig.port ?? 3000,
        });
      }
    }
  }

  if (routes.length === 0) {
    console.log('   ⚠️  No domains configured, skipping nginx.conf generation');
    return 0;
  }

  // Generate nginx config
  let nginxConf = `# Auto-generated nginx configuration
# Generated by: factiii generate-all.js
# Do not edit directly - modify factiii.yml files and run: npx factiii deploy

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    sendfile on;
    keepalive_timeout 65;
    client_max_body_size 100M;

    # Logging
    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    # Gzip
    gzip on;
    gzip_vary on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

`;

  for (const { domain, service, port } of routes) {
    nginxConf += `
    # ${service} - ${domain}
    server {
        listen 80;
        server_name ${domain};

        location / {
            proxy_pass http://${service}:${port};
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection 'upgrade';
            proxy_set_header Host $host;
            proxy_cache_bypass $http_upgrade;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
    }
`;
  }

  nginxConf += `}\n`;

  // Write nginx.conf
  const outputPath = path.join(getFactiiiDir(), 'nginx.conf');
  fs.writeFileSync(outputPath, nginxConf);

  return routes.length;
}

/**
 * Main execution
 */
function main(): void {
  console.log('🔍 Scanning ~/.factiii for repos...');

  const repos = scanRepos();
  console.log(`   Found ${repos.length} repo(s)`);

  if (repos.length === 0) {
    console.log('⚠️  No repos found in ~/.factiii');
    process.exit(0);
  }

  console.log('\n📋 Loading configs...');
  const allConfigs = loadConfigs(repos);
  console.log(`   Loaded ${Object.keys(allConfigs).length} config(s)`);

  console.log('\n🔨 Generating docker-compose.yml...');
  const serviceCount = generateDockerCompose(allConfigs);
  console.log(`   ✅ Generated ${serviceCount} service(s)`);

  console.log('\n🔨 Generating nginx.conf...');
  const domainCount = generateNginx(allConfigs);
  console.log(`   ✅ Generated ${domainCount} route(s)`);

  console.log('\n✅ Configuration generation complete!');
  console.log(`   docker-compose.yml: ~/.factiii/docker-compose.yml`);
  console.log(`   nginx.conf: ~/.factiii/nginx.conf`);
}

// Run if called directly
if (require.main === module) {
  main();
}

