/**
 * DNS Validator
 *
 * Utilities for validating and resolving hostnames.
 */

import * as dns from 'dns';

const dnsPromises = dns.promises;

/**
 * Check if a hostname is resolvable
 */
export async function isHostnameResolvable(hostname: string): Promise<boolean> {
  try {
    await dnsPromises.lookup(hostname);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate common hostname variations to check
 * e.g., "staging-api.domain.com" -> ["api-staging.domain.com", "staging.api.domain.com"]
 */
export function generateHostnameVariations(hostname: string): string[] {
  const parts = hostname.split('.');
  if (parts.length < 3) return [];

  const subdomain = parts[0];
  const domain = parts.slice(1).join('.');

  if (!subdomain) return [];

  const variations: string[] = [];

  // Check for hyphenated subdomains
  if (subdomain.includes('-')) {
    const subParts = subdomain.split('-');
    // Reverse order: "staging-api" -> "api-staging"
    const reversed = [...subParts].reverse();
    variations.push(`${reversed.join('-')}.${domain}`);
    // Dot notation: "staging-api" -> "staging.api"
    variations.push(`${subParts.join('.')}.${domain}`);
  }

  return variations;
}

/**
 * Find a resolvable alternative hostname
 */
export async function findResolvableAlternative(
  hostname: string
): Promise<string | null> {
  const variations = generateHostnameVariations(hostname);

  for (const variation of variations) {
    if (await isHostnameResolvable(variation)) {
      return variation;
    }
  }

  return null;
}

