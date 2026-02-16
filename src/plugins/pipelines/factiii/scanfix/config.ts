/**
 * Configuration-related fixes for Factiii Pipeline plugin
 * Handles factiii.yml file generation and validation
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

export const configFixes: Fix[] = [
  {
    id: 'example-values-in-config',
    stage: 'dev',
    severity: 'critical',
    description: 'factiii.yml contains EXAMPLE- placeholder values that must be replaced',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const configPath = path.join(rootDir, 'factiii.yml');
      if (!fs.existsSync(configPath)) return false;
      const content = fs.readFileSync(configPath, 'utf8');
      return content.includes('EXAMPLE-');
    },
    fix: null,
    manualFix:
      'Replace all EXAMPLE- prefixed values in factiii.yml with your actual values:\n' +
      '      - name: your-repo-name\n' +
      '      - github_repo: your-username/your-repo\n' +
      '      - ssl_email: your-email@domain.com\n' +
      '      - staging.domain: staging.yourdomain.com\n' +
      '      - prod.domain: yourdomain.com',
  },
  {
    id: 'missing-factiii-yml',
    stage: 'dev',
    severity: 'critical',
    description: 'factiii.yml configuration file not found',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      return !fs.existsSync(path.join(rootDir, 'factiii.yml'));
    },
    fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      // Generate from plugin schemas
      const { generateFactiiiYml } = await import(
        '../../../../generators/generate-factiii-yml.js'
      );
      return generateFactiiiYml(rootDir, { force: false });
    },
    manualFix: 'Run: npx factiii fix (will create factiii.yml from plugin schemas)',
  },
];

