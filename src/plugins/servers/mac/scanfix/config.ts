/**
 * Configuration-related fixes for macOS plugin
 * Handles configuration checks and file validation
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

export const configFixes: Fix[] = [
  // DEV STAGE FIXES
  {
    id: 'missing-dockerfile-dev',
    stage: 'dev',
    severity: 'warning',
    description: '🐳 Dockerfile not found',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const commonPaths = [
        'Dockerfile',
        'apps/server/Dockerfile',
        'packages/server/Dockerfile',
      ];
      for (const p of commonPaths) {
        if (fs.existsSync(path.join(rootDir, p))) return false;
      }
      return true;
    },
    fix: null,
    manualFix: 'Create a Dockerfile in your project root. Minimal example:\n' +
      '      FROM node:18-alpine\n' +
      '      WORKDIR /app\n' +
      '      COPY package*.json ./\n' +
      '      RUN npm install --production\n' +
      '      COPY . .\n' +
      '      CMD ["node", "dist/index.js"]',
  },
  {
    id: 'missing-docker-compose-dev',
    stage: 'dev',
    severity: 'info',
    description: '🐳 docker-compose.yml not found (optional for dev)',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      return (
        !fs.existsSync(path.join(rootDir, 'docker-compose.yml')) &&
        !fs.existsSync(path.join(rootDir, 'compose.yml'))
      );
    },
    fix: null,
    manualFix: 'Create docker-compose.yml for local development (optional). Example:\n' +
      '      services:\n' +
      '        app:\n' +
      '          build: .\n' +
      '          ports:\n' +
      '            - "3000:3000"\n' +
      '          volumes:\n' +
      '            - .:/app',
  },

  // STAGING STAGE FIXES
  {
    id: 'staging-domain-missing',
    stage: 'staging',
    severity: 'critical',
    description: '🌐 Staging domain not configured in stack.yml',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      // Only check if staging environment is defined in config
      const hasStagingEnv = environments.staging;
      if (!hasStagingEnv) return false; // Skip check if staging not configured

      return !environments.staging?.domain;
    },
    fix: null,
    manualFix: 'Add staging.domain to stack.yml. Example:\n' +
      '      staging:\n' +
      '        server: mac\n' +
      '        domain: staging.yourdomain.com\n' +
      '        env_file: .env.staging',
  },
  {
    id: 'staging-unreachable',
    stage: 'staging',
    severity: 'critical',
    description: '🌐 Cannot reach staging server',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      // Only check if staging environment is defined in config
      const hasStagingEnv = environments.staging;
      if (!hasStagingEnv) return false; // Skip check if staging not configured

      const domain = environments.staging?.domain;
      if (!domain) return false; // Will be caught by staging-domain-missing

      try {
        // Try to ping the domain
        execSync(`ping -c 1 -W 3 ${domain}`, { stdio: 'pipe' });
        return false;
      } catch {
        return true;
      }
    },
    fix: null,
    manualFix: 'Check network connectivity to staging server',
  },
  {
    id: 'staging-repo-not-cloned',
    stage: 'staging',
    severity: 'warning',
    description: '📂 Repository not cloned on staging server',
    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const { extractEnvironments } = await import('../../../../utils/config-helpers.js');
      const environments = extractEnvironments(config);

      const hasStagingEnv = environments.staging;
      if (!hasStagingEnv) return false;

      const domain = environments.staging?.domain;
      if (!domain) return false;

      const repoName = config.name ?? 'app';

      // Executed locally - SSH handled by CLI wrapper
      try {
        const repoPath = path.join(process.env.HOME ?? os.homedir(), '.factiii', repoName, '.git');
        return !fs.existsSync(repoPath);
      } catch {
        return true;
      }
    },
    fix: null, // Will be handled by ensureServerReady()
    manualFix: 'Repository will be cloned automatically on first deployment',
  },
];

