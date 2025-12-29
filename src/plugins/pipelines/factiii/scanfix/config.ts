/**
 * Configuration-related fixes for Factiii Pipeline plugin
 * Handles factiii.yml file generation and validation
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';

export const configFixes: Fix[] = [
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

