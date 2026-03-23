/**
 * DNS Dev Stage Fixes
 *
 * Checks that domains configured in stack.yml resolve to the expected targets.
 * Does NOT call any DNS provider API — just does local DNS lookups and compares
 * against the expected values cached in stackAuto.yml.
 *
 * If a mismatch is found, tells the user to update their DNS provider manually.
 * The fix function offers to acknowledge the warning so it stops appearing.
 */

import * as dns from 'dns';
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import type { Fix, FactiiiConfig } from '../../../../types/index.js';
import { getStackAutoPath } from '../../../../constants/config-files.js';

const dnsPromises = dns.promises;

// ============================================================
// Types
// ============================================================

interface DnsEntry {
  host: string;       // subdomain label ("api", "www", or "" for root)
  target: string;     // expected CNAME / A record value
}

interface DnsAutoConfig {
  dns?: {
    records?: Array<{ host: string; target: string; acknowledged?: boolean }>;
  };
}

// ============================================================
// Helpers
// ============================================================

/**
 * Build the FQDN from the environment domain + record host label.
 * e.g. domain="dev.example.com", host="api" => "api.dev.example.com"
 *      domain="dev.example.com", host=""    => "dev.example.com"
 */
function buildFqdn(domain: string, host: string): string {
  if (!host || host === '@') return domain;
  return host + '.' + domain;
}

/**
 * Resolve a hostname and return what it points to (CNAME chain or A record).
 */
async function resolveTarget(fqdn: string): Promise<string | null> {
  // Try CNAME first
  try {
    const cnames = await dnsPromises.resolveCname(fqdn);
    if (cnames.length > 0) return cnames[0];
  } catch {
    // Not a CNAME, try A record
  }
  try {
    const addresses = await dnsPromises.resolve4(fqdn);
    if (addresses.length > 0) return addresses[0];
  } catch {
    // No A record either
  }
  return null;
}

/**
 * Read the dns section from stackAuto.yml
 */
function readDnsAuto(rootDir: string): DnsAutoConfig {
  try {
    const autoPath = getStackAutoPath(rootDir);
    if (!fs.existsSync(autoPath)) return {};
    const content = fs.readFileSync(autoPath, 'utf8');
    return (yaml.load(content) as DnsAutoConfig) || {};
  } catch {
    return {};
  }
}

/**
 * Check if a specific record has been acknowledged in stackAuto.yml
 */
function isAcknowledged(rootDir: string, fqdn: string): boolean {
  const auto = readDnsAuto(rootDir);
  if (!auto.dns?.records) return false;
  return auto.dns.records.some(
    r => buildFqdn('', r.host) === fqdn && r.acknowledged === true
  );
}

/**
 * Write acknowledgement for a record into stackAuto.yml
 */
function acknowledgeRecord(rootDir: string, fqdn: string, target: string): void {
  const autoPath = getStackAutoPath(rootDir);
  let autoConfig: Record<string, unknown> = {};

  try {
    if (fs.existsSync(autoPath)) {
      autoConfig = (yaml.load(fs.readFileSync(autoPath, 'utf8')) as Record<string, unknown>) || {};
    }
  } catch {
    autoConfig = {};
  }

  // Ensure dns.records array exists
  if (!autoConfig.dns || typeof autoConfig.dns !== 'object') {
    autoConfig.dns = { records: [] };
  }
  const dnsSection = autoConfig.dns as { records?: Array<{ fqdn: string; target: string; acknowledged: boolean }> };
  if (!dnsSection.records) {
    dnsSection.records = [];
  }

  // Update or add the record
  const existing = dnsSection.records.find(r => r.fqdn === fqdn);
  if (existing) {
    existing.target = target;
    existing.acknowledged = true;
  } else {
    dnsSection.records.push({ fqdn, target, acknowledged: true });
  }

  fs.writeFileSync(autoPath, yaml.dump(autoConfig, { lineWidth: -1, noRefs: true }));
}

/**
 * Get DNS records from the dev environment's plugins.dns config
 */
function getDnsRecords(config: FactiiiConfig): { domain: string; records: DnsEntry[] } | null {
  // Look for dev environment
  const dev = config.dev as { domain?: string; plugins?: Record<string, Record<string, unknown>> } | undefined;
  if (!dev?.domain) return null;

  const dnsPlugin = dev.plugins?.dns as { records?: DnsEntry[] } | undefined;
  if (!dnsPlugin?.records || dnsPlugin.records.length === 0) return null;

  return { domain: dev.domain, records: dnsPlugin.records };
}

// ============================================================
// Fixes
// ============================================================

export const dnsFixes: Fix[] = [];

// Single dev-stage fix that checks all configured DNS records
dnsFixes.push({
  id: 'dns-records-dev',
  stage: 'dev',
  severity: 'warning',
  description: 'DNS records not pointing to expected targets',
  plugin: 'dns',

  scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
    const dnsConfig = getDnsRecords(config);
    if (!dnsConfig) return false; // No DNS config = nothing to check

    const { domain, records } = dnsConfig;

    for (const record of records) {
      const fqdn = buildFqdn(domain, record.host);

      // Skip if user already acknowledged this warning
      const auto = readDnsAuto(rootDir);
      const autoRecord = auto.dns?.records?.find(
        (r: { fqdn?: string; host?: string; target?: string; acknowledged?: boolean }) =>
          (r.fqdn === fqdn || buildFqdn(domain, r.host || '') === fqdn) &&
          r.target === record.target &&
          r.acknowledged === true
      );
      if (autoRecord) continue;

      // Do DNS lookup
      const resolved = await resolveTarget(fqdn);

      if (!resolved) {
        console.log('   ⚠️  ' + fqdn + ' does not resolve (expected: ' + record.target + ')');
        return true;
      }

      // Normalize trailing dots for comparison
      const normalizedResolved = resolved.replace(/\.$/, '');
      const normalizedTarget = record.target.replace(/\.$/, '');

      if (normalizedResolved !== normalizedTarget) {
        console.log('   ⚠️  ' + fqdn + ' points to ' + resolved + ' (expected: ' + record.target + ')');
        return true;
      }
    }

    return false; // All records match or are acknowledged
  },

  fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
    const dnsConfig = getDnsRecords(config);
    if (!dnsConfig) return false;

    const { domain, records } = dnsConfig;
    let hasIssues = false;

    for (const record of records) {
      const fqdn = buildFqdn(domain, record.host);
      const resolved = await resolveTarget(fqdn);
      const normalizedResolved = resolved?.replace(/\.$/, '') || '';
      const normalizedTarget = record.target.replace(/\.$/, '');

      if (normalizedResolved !== normalizedTarget) {
        hasIssues = true;
        if (!resolved) {
          console.log('   ⚠️  ' + fqdn + ' does not resolve');
        } else {
          console.log('   ⚠️  ' + fqdn + ' → ' + resolved + ' (expected: ' + record.target + ')');
        }
        console.log('      Update this DNS record at your DNS provider (Dynu, Cloudflare, etc.)');
        console.log('');

        // Acknowledge so it doesn't keep warning
        acknowledgeRecord(rootDir, fqdn, record.target);
        console.log('   ✅ Warning acknowledged — will re-check if target changes in stack.yml');
      }
    }

    if (!hasIssues) {
      console.log('   ✅ All DNS records are correct');
    }

    return true;
  },

  manualFix: 'Update DNS records at your DNS provider to match the targets in stack.yml dev.plugins.dns.records',
});
