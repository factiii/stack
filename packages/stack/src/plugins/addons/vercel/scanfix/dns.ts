/**
 * Vercel DNS Scanfixes
 *
 * Creates Route53 DNS records for Vercel deployment:
 * - A record: root domain → 76.76.21.21 (Vercel anycast)
 * - CNAME record: www → cname.vercel-dns.com
 *
 * Uses AWS SDK via existing aws-helpers utilities.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { extractEnvironments } from '../../../../utils/config-helpers.js';

// Vercel's anycast IP for custom domains
const VERCEL_ANYCAST_IP = '76.76.21.21';
const VERCEL_CNAME = 'cname.vercel-dns.com';

/**
 * Get the root domain from a subdomain (e.g., api.facti.us → facti.us)
 */
function getRootDomain(domain: string): string {
    const parts = domain.split('.');
    if (parts.length <= 2) return domain;
    return parts.slice(-2).join('.');
}

/**
 * Check if a domain looks like a proper domain (not IP or placeholder)
 */
function isProperDomain(domain: string): boolean {
    if (!domain) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) return false;
    if (domain.toUpperCase().startsWith('EXAMPLE')) return false;
    if (!domain.includes('.')) return false;
    return true;
}

/**
 * Get the Vercel domain from config.
 * Uses vercel.domain if set, otherwise derives root domain from prod domain.
 * Example: prod domain is api.facti.us → Vercel domain is facti.us
 */
function getVercelDomain(config: FactiiiConfig): string | null {
    // Explicit vercel domain in config
    const vercelDomain = (config.vercel as Record<string, unknown> | null)?.domain as string | undefined;
    if (vercelDomain && isProperDomain(vercelDomain)) return vercelDomain;

    // Derive from prod domain (root domain serves frontend)
    const environments = extractEnvironments(config);
    const prodEnv = environments.prod ?? environments.production;
    const prodDomain = prodEnv?.domain;
    if (!prodDomain || !isProperDomain(prodDomain)) return null;

    return getRootDomain(prodDomain);
}

export const dnsFixes: Fix[] = [
    {
        id: 'vercel-dns-a-record',
        stage: 'prod',
        severity: 'warning',
        description: '🌐 DNS A record not pointing to Vercel for frontend domain',
        scan: async (config: FactiiiConfig): Promise<boolean> => {
            if (config.vercel === undefined) return false;

            // Need AWS configured for Route53
            try {
                const { isAwsConfigured, getAwsConfig, findHostedZone, findARecord } =
                    await import('../../../pipelines/aws/utils/aws-helpers.js');
                if (!isAwsConfigured(config)) return false;

                const { region } = getAwsConfig(config);
                const domain = getVercelDomain(config);
                if (!domain) return false;

                // Need a hosted zone
                const zoneId = await findHostedZone(domain, region);
                if (!zoneId) return false;

                // Check if A record points to Vercel
                const existingIp = await findARecord(domain, zoneId, region);
                return existingIp !== VERCEL_ANYCAST_IP;
            } catch {
                return false; // AWS not available, skip
            }
        },
        fix: async (config: FactiiiConfig): Promise<boolean> => {
            const domain = getVercelDomain(config);
            if (!domain) {
                console.log('   No Vercel domain found — configure vercel.domain or prod domain in stack.yml');
                return false;
            }

            try {
                const { isAwsConfigured, getAwsConfig, findHostedZone, getRoute53Client, ChangeResourceRecordSetsCommand } =
                    await import('../../../pipelines/aws/utils/aws-helpers.js');
                if (!isAwsConfigured(config)) {
                    console.log('   AWS not configured — cannot manage Route53 DNS');
                    return false;
                }

                const { region } = getAwsConfig(config);
                const zoneId = await findHostedZone(domain, region);
                if (!zoneId) {
                    console.log('   Route53 hosted zone for ' + domain + ' not found — create it first with: npx stack fix --prod');
                    return false;
                }

                const r53 = getRoute53Client(region);

                // Create A record: root domain → Vercel anycast IP
                await r53.send(new ChangeResourceRecordSetsCommand({
                    HostedZoneId: zoneId,
                    ChangeBatch: {
                        Changes: [
                            {
                                Action: 'UPSERT',
                                ResourceRecordSet: {
                                    Name: domain,
                                    Type: 'A',
                                    TTL: 300,
                                    ResourceRecords: [{ Value: VERCEL_ANYCAST_IP }],
                                },
                            },
                        ],
                    },
                }));

                console.log('   Created A record: ' + domain + ' → ' + VERCEL_ANYCAST_IP + ' (Vercel)');

                // Create CNAME record: www → Vercel
                await r53.send(new ChangeResourceRecordSetsCommand({
                    HostedZoneId: zoneId,
                    ChangeBatch: {
                        Changes: [
                            {
                                Action: 'UPSERT',
                                ResourceRecordSet: {
                                    Name: 'www.' + domain,
                                    Type: 'CNAME',
                                    TTL: 300,
                                    ResourceRecords: [{ Value: VERCEL_CNAME }],
                                },
                            },
                        ],
                    },
                }));

                console.log('   Created CNAME record: www.' + domain + ' → ' + VERCEL_CNAME);
                console.log('   DNS propagation may take up to 48 hours.');
                console.log('   Vercel will auto-provision SSL via Let\'s Encrypt.');
                return true;
            } catch (e) {
                console.log('   Failed to create DNS records: ' + (e instanceof Error ? e.message : String(e)));
                return false;
            }
        },
        manualFix: 'Add DNS records at your domain registrar:\n  A record: @ → 76.76.21.21 (Vercel)\n  CNAME record: www → cname.vercel-dns.com',
    },
];
