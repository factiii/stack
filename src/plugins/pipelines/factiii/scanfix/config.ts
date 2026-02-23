/**
 * Configuration-related fixes for Factiii Pipeline plugin
 * Validates stack.yml content (EXAMPLE- values, etc.)
 *
 * Note: Missing stack.yml detection is in bootstrap.ts (runs first).
 */

import * as fs from 'fs';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { getStackConfigPath, STACK_CONFIG_FILENAME } from '../../../../constants/config-files.js';

export const configFixes: Fix[] = [
  {
    id: 'example-values-in-config',
    stage: 'dev',
    severity: 'critical',
    description: STACK_CONFIG_FILENAME + ' contains EXAMPLE- placeholder values that must be replaced',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const configPath = getStackConfigPath(rootDir);
      if (!fs.existsSync(configPath)) return false;
      const content = fs.readFileSync(configPath, 'utf8');
      return content.includes('EXAMPLE-');
    },
    fix: null,
    manualFix:
      'Replace all EXAMPLE- prefixed values in ' + STACK_CONFIG_FILENAME + ' with your actual values:\n' +
      '      - name: your-repo-name\n' +
      '      - github_repo: your-username/your-repo\n' +
      '      - ssl_email: your-email@domain.com\n' +
      '      - staging.domain: staging.yourdomain.com\n' +
      '      - prod.domain: yourdomain.com',
  },
];

