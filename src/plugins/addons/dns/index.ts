/**
 * DNS Addon
 *
 * Validates that DNS records resolve to the expected targets.
 * Does NOT call any DNS provider API — works with any provider (Dynu, Cloudflare, etc.)
 *
 * ============================================================
 * USAGE
 * ============================================================
 *
 * Configure in stack.yml:
 *
 * dev:
 *   domain: dev.example.com
 *   plugins:
 *     dns:
 *       records:
 *         - host: ""          # root domain → Vercel
 *           target: cname.vercel-dns.com
 *         - host: api         # api.dev.example.com → AWS ALB
 *           target: my-alb.us-east-1.elb.amazonaws.com
 *
 * On scan: does DNS lookup, warns if records don't match expected targets.
 * On fix: shows what needs updating, acknowledges warning in stackAuto.yml.
 *         Re-checks automatically if target changes in stack.yml.
 * ============================================================
 */

import type { FactiiiConfig, Fix } from '../../../types/index.js';
import { dnsFixes } from './scanfix/dev.js';

class DnsAddon {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'dns';
  static readonly name = 'DNS';
  static readonly category: 'addon' = 'addon';
  static readonly version = '1.0.0';

  static readonly requiredEnvVars: string[] = [];

  static readonly configSchema: Record<string, unknown> = {
    // Defined per-environment under plugins.dns.records
  };

  static readonly autoConfigSchema: Record<string, string> = {};

  /**
   * Determine if this addon should be loaded.
   * Loads if any environment has plugins.dns configured.
   */
  static async shouldLoad(_rootDir: string, config: FactiiiConfig): Promise<boolean> {
    const { extractEnvironments } = await import('../../../utils/config-helpers.js');
    const environments = extractEnvironments(config);

    return Object.values(environments).some(env => {
      const dnsPlugin = env.plugins?.dns as { records?: unknown[] } | undefined;
      return dnsPlugin?.records && dnsPlugin.records.length > 0;
    });
  }

  // ============================================================
  // FIXES
  // ============================================================

  static readonly fixes: Fix[] = [
    ...dnsFixes,
  ];

  // ============================================================
  // INSTANCE
  // ============================================================

  private _config: FactiiiConfig;

  constructor(config: FactiiiConfig) {
    this._config = config;
  }
}

export default DnsAddon;
