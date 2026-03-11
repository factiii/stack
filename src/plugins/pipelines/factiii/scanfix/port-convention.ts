/**
 * Port convention scanfixes for Factiii Pipeline plugin
 *
 * Enforces the slot-based PORT system:
 * - PORT=N (1-5) in .env.example, NOT full ports like 3001/5001
 * - App derives: client = 3000+N, server = 5000+N
 * - Dev envs use http://, staging/prod use https://
 */

import * as fs from 'fs';
import * as path from 'path';
import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { parseEnvFile } from '../../../../utils/env-validator.js';
import { extractEnvironments, hasEnvironments } from '../../../../utils/config-helpers.js';

/**
 * Keys that commonly hold URLs (checked for http/https protocol)
 */
const URL_KEY_PATTERNS = [
  'API_URL',
  'NEXT_PUBLIC_API_URL',
  'EXPO_PUBLIC_API_URL',
  'FRONTEND_URL',
  'NEXT_PUBLIC_URL',
  'EXPO_PUBLIC_URL',
  'APP_URL',
  'BASE_URL',
  'WEBSITE_URL',
  'CALLBACK_URL',
  'REDIRECT_URL',
];

/**
 * Check if an env key looks like a URL variable
 */
function isUrlKey(key: string): boolean {
  return URL_KEY_PATTERNS.some(pattern => key.toUpperCase().includes(pattern)) ||
    key.toUpperCase().endsWith('_URL') ||
    key.toUpperCase().endsWith('_HOST');
}

/**
 * Try to convert a full port number to a slot number.
 * 3001-3009 → 1-9 (strip 3000)
 * 5001-5009 → 1-9 (strip 5000)
 * Returns null if not a recognizable pattern.
 */
function fullPortToSlot(port: number): number | null {
  if (port >= 3001 && port <= 3009) return port - 3000;
  if (port >= 5001 && port <= 5009) return port - 5000;
  return null;
}

/**
 * Replace http:// or https:// in URL values within an env file
 */
function replaceProtocolInEnvFile(filePath: string, fromProtocol: string, toProtocol: string): boolean {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  let changed = false;

  const updated = lines.map(line => {
    // Skip comments and empty lines
    if (line.trimStart().startsWith('#') || !line.includes('=')) return line;

    const eqIdx = line.indexOf('=');
    const key = line.substring(0, eqIdx).trim();
    const value = line.substring(eqIdx + 1);

    if (isUrlKey(key) && value.includes(fromProtocol)) {
      changed = true;
      return key + '=' + value.replace(new RegExp(fromProtocol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), toProtocol);
    }
    return line;
  });

  if (changed) {
    fs.writeFileSync(filePath, updated.join('\n'), 'utf8');
  }
  return changed;
}

export const portConventionFixes: Fix[] = [
  // ── PORT slot validation ────────────────────────────────────────

  {
    id: 'env-example-missing-port',
    stage: 'dev',
    severity: 'critical',
    description: '🔌 .env.example missing PORT variable (required for slot-based port system)',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (!hasEnvironments(_config)) return false;
      const envPath = path.join(rootDir, '.env.example');
      if (!fs.existsSync(envPath)) return false;

      const vars = parseEnvFile(envPath);
      if (!vars) return false;
      return !('PORT' in vars);
    },
    fix: null,
    manualFix:
      'Add PORT to .env.example with your repo slot number (1-5):\n' +
      '      PORT=1\n' +
      '      # Slot number: client=3000+PORT, server=5000+PORT\n' +
      '      # Slot 1 → client:3001, server:5001\n' +
      '      # Slot 2 → client:3002, server:5002',
  },

  {
    id: 'env-example-port-not-slot',
    stage: 'dev',
    severity: 'critical',
    get description(): string {
      const port = (this as any)._portValue as string | undefined;
      if (port) {
        const num = parseInt(port, 10);
        const slot = fullPortToSlot(num);
        if (slot) {
          return '🔌 PORT=' + port + ' in .env.example should be slot number ' + slot + ' (not a full port)';
        }
        return '🔌 PORT=' + port + ' in .env.example should be a slot number (1-5), not a full port';
      }
      return '🔌 PORT in .env.example should be a slot number (1-5), not a full port';
    },
    scan: async function (_config: FactiiiConfig, rootDir: string): Promise<boolean> {
      if (!hasEnvironments(_config)) return false;
      const envPath = path.join(rootDir, '.env.example');
      if (!fs.existsSync(envPath)) return false;

      const vars = parseEnvFile(envPath);
      if (!vars || !('PORT' in vars)) return false;

      const portVal = parseInt(vars.PORT ?? '', 10);
      if (isNaN(portVal)) return false;

      // PORT should be 1-5 (slot number)
      if (portVal >= 1 && portVal <= 5) return false;

      (this as any)._portValue = vars.PORT;
      return true;
    },
    fix: async function (_config: FactiiiConfig, rootDir: string): Promise<boolean> {
      const envPath = path.join(rootDir, '.env.example');
      const vars = parseEnvFile(envPath);
      if (!vars || !('PORT' in vars)) return false;

      const portVal = parseInt(vars.PORT ?? '', 10);
      const slot = fullPortToSlot(portVal);
      if (!slot) return false; // Can't auto-convert, needs manual

      // Replace PORT value in the file
      const content = fs.readFileSync(envPath, 'utf8');
      const updated = content.replace(
        /^PORT=\d+/m,
        'PORT=' + slot
      );
      fs.writeFileSync(envPath, updated, 'utf8');
      console.log('   Converted PORT=' + portVal + ' → PORT=' + slot + ' (slot number)');
      return true;
    },
    manualFix:
      'Change PORT in .env.example to a slot number (1-5):\n' +
      '      PORT=1  # → client:3001, server:5001\n' +
      '      PORT=2  # → client:3002, server:5002',
  },

  // ── Dev: http:// enforcement ──────────────────────────────────

  {
    id: 'dev-env-https-urls',
    stage: 'dev',
    severity: 'warning',
    description: '🔗 .env.example has https:// URLs (dev should use http://)',
    scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      if (!hasEnvironments(_config)) return false;
      const envPath = path.join(rootDir, '.env.example');
      if (!fs.existsSync(envPath)) return false;

      const vars = parseEnvFile(envPath);
      if (!vars) return false;

      for (const [key, value] of Object.entries(vars)) {
        if (isUrlKey(key) && value.includes('https://')) {
          return true;
        }
      }
      return false;
    },
    fix: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const envPath = path.join(rootDir, '.env.example');
      if (!fs.existsSync(envPath)) return false;
      const changed = replaceProtocolInEnvFile(envPath, 'https://', 'http://');
      if (changed) {
        console.log('   Replaced https:// → http:// in .env.example URL vars');
      }
      return changed;
    },
    manualFix: 'Change https:// to http:// in .env.example URL variables (dev should use http)',
  },

  // ── Staging: https:// enforcement ─────────────────────────────

  {
    id: 'staging-env-http-urls',
    stage: 'dev',
    targetStage: 'staging',
    severity: 'critical',
    description: '🔗 .env.staging has http:// URLs (staging MUST use https://)',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const envs = extractEnvironments(config);
      if (!envs.staging) return false;

      const envPath = path.join(rootDir, '.env.staging');
      if (!fs.existsSync(envPath)) return false;

      const vars = parseEnvFile(envPath);
      if (!vars) return false;

      for (const [key, value] of Object.entries(vars)) {
        if (isUrlKey(key) && value.includes('http://') && !value.includes('localhost') && !value.includes('127.0.0.1')) {
          return true;
        }
      }
      return false;
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const envs = extractEnvironments(config);
      if (!envs.staging) return false;

      const envPath = path.join(rootDir, '.env.staging');
      if (!fs.existsSync(envPath)) return false;

      // Only replace http:// that isn't localhost
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split('\n');
      let changed = false;

      const updated = lines.map(line => {
        if (line.trimStart().startsWith('#') || !line.includes('=')) return line;
        const eqIdx = line.indexOf('=');
        const key = line.substring(0, eqIdx).trim();
        const value = line.substring(eqIdx + 1);

        if (isUrlKey(key) && value.includes('http://') && !value.includes('localhost') && !value.includes('127.0.0.1')) {
          changed = true;
          return key + '=' + value.replace(/http:\/\//g, 'https://');
        }
        return line;
      });

      if (changed) {
        fs.writeFileSync(envPath, updated.join('\n'), 'utf8');
        console.log('   Replaced http:// → https:// in .env.staging URL vars');
      }
      return changed;
    },
    manualFix: 'Change http:// to https:// in .env.staging URL variables (staging should use https)',
  },

  // ── Prod: https:// enforcement ────────────────────────────────

  {
    id: 'prod-env-http-urls',
    stage: 'dev',
    targetStage: 'prod',
    severity: 'critical',
    description: '🔗 .env.prod has http:// URLs (production MUST use https://)',
    scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const envs = extractEnvironments(config);
      const hasProd = !!envs.prod || !!envs.production;
      if (!hasProd) return false;

      const envPath = path.join(rootDir, '.env.prod');
      if (!fs.existsSync(envPath)) return false;

      const vars = parseEnvFile(envPath);
      if (!vars) return false;

      for (const [key, value] of Object.entries(vars)) {
        if (isUrlKey(key) && value.includes('http://') && !value.includes('localhost') && !value.includes('127.0.0.1')) {
          return true;
        }
      }
      return false;
    },
    fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
      const envs = extractEnvironments(config);
      const hasProd = !!envs.prod || !!envs.production;
      if (!hasProd) return false;

      const envPath = path.join(rootDir, '.env.prod');
      if (!fs.existsSync(envPath)) return false;

      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split('\n');
      let changed = false;

      const updated = lines.map(line => {
        if (line.trimStart().startsWith('#') || !line.includes('=')) return line;
        const eqIdx = line.indexOf('=');
        const key = line.substring(0, eqIdx).trim();
        const value = line.substring(eqIdx + 1);

        if (isUrlKey(key) && value.includes('http://') && !value.includes('localhost') && !value.includes('127.0.0.1')) {
          changed = true;
          return key + '=' + value.replace(/http:\/\//g, 'https://');
        }
        return line;
      });

      if (changed) {
        fs.writeFileSync(envPath, updated.join('\n'), 'utf8');
        console.log('   Replaced http:// → https:// in .env.prod URL vars');
      }
      return changed;
    },
    manualFix: 'Change http:// to https:// in .env.prod URL variables (production MUST use https)',
  },
];
