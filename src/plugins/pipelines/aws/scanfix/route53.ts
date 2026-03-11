/**
 * AWS Route53 Domain Fixes
 *
 * Provisions Route53 hosted zone and A record for prod domain.
 * Points the domain to the EC2 Elastic IP.
 * Uses AWS SDK v3.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import {
    getAwsConfig,
    getProjectName,
    isAwsConfigured,
    findInstance,
    findElasticIp,
    findHostedZone,
    findARecord,
    getRoute53Client,
    CreateHostedZoneCommand,
    ChangeResourceRecordSetsCommand,
    GetHostedZoneCommand,
} from '../utils/aws-helpers.js';
import { extractEnvironments } from '../../../../utils/config-helpers.js';

/**
 * Check if a domain looks like a proper domain name (not an IP or placeholder)
 */
function isProperDomain(domain: string): boolean {
    if (!domain) return false;
    // Skip IPs (e.g. 1.2.3.4)
    if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) return false;
    // Skip EXAMPLE_ placeholders
    if (domain.toUpperCase().startsWith('EXAMPLE')) return false;
    // Must have at least one dot (e.g. example.com)
    if (!domain.includes('.')) return false;
    return true;
}

export const route53Fixes: Fix[] = [
    {
        id: 'aws-route53-zone',
        stage: 'prod',
        severity: 'warning',
        description: '🌐 Route53 hosted zone not created for prod domain',
        scan: async (config: FactiiiConfig): Promise<boolean> => {
            if (!isAwsConfigured(config)) return false;
            const { region } = getAwsConfig(config);

            // Get prod domain from config
            const environments = extractEnvironments(config);
            const prodEnv = environments.prod ?? environments.production;
            const domain = prodEnv?.domain;
            if (!domain || !isProperDomain(domain)) return false;

            // Check if hosted zone exists
            return !(await findHostedZone(domain, region));
        },
        fix: async (config: FactiiiConfig): Promise<boolean> => {
            const { region } = getAwsConfig(config);
            const environments = extractEnvironments(config);
            const prodEnv = environments.prod ?? environments.production;
            const domain = prodEnv?.domain;
            if (!domain || !isProperDomain(domain)) {
                console.log('   Prod domain not configured or is an IP address — skipping Route53');
                return false;
            }

            try {
                const r53 = getRoute53Client(region);

                // Create hosted zone with a unique caller reference
                const callerRef = 'factiii-' + Date.now();
                const result = await r53.send(new CreateHostedZoneCommand({
                    Name: domain,
                    CallerReference: callerRef,
                }));

                const zoneId = result.HostedZone?.Id?.replace('/hostedzone/', '');
                console.log('   Created Route53 hosted zone: ' + zoneId);
                console.log('   Domain: ' + domain);

                // Get the NS records to show the user
                if (zoneId) {
                    const zoneDetail = await r53.send(new GetHostedZoneCommand({
                        Id: zoneId,
                    }));
                    const nameServers = zoneDetail.DelegationSet?.NameServers ?? [];
                    if (nameServers.length > 0) {
                        console.log('');
                        console.log('   ⚠️  IMPORTANT: Point your domain to these AWS name servers:');
                        for (const ns of nameServers) {
                            console.log('      ' + ns);
                        }
                        console.log('');
                        console.log('   Update the NS records at your domain registrar.');
                        console.log('   DNS propagation may take up to 48 hours.');
                    }
                }

                return true;
            } catch (e) {
                console.log('   Failed to create hosted zone: ' + (e instanceof Error ? e.message : String(e)));
                return false;
            }
        },
        manualFix: 'Create Route53 hosted zone: aws route53 create-hosted-zone --name YOUR_DOMAIN --caller-reference factiii-$(date +%s)',
    },
    {
        id: 'aws-route53-a-record',
        stage: 'prod',
        severity: 'warning',
        description: '🌐 Route53 A record not pointing to EC2 Elastic IP',
        scan: async (config: FactiiiConfig): Promise<boolean> => {
            if (!isAwsConfigured(config)) return false;
            const { region } = getAwsConfig(config);
            const projectName = getProjectName(config);

            // Get prod domain from config
            const environments = extractEnvironments(config);
            const prodEnv = environments.prod ?? environments.production;
            const domain = prodEnv?.domain;
            if (!domain || !isProperDomain(domain)) return false;

            // Need a hosted zone first
            const zoneId = await findHostedZone(domain, region);
            if (!zoneId) return false;

            // Need an EC2 instance with Elastic IP
            const instanceId = await findInstance(projectName, region);
            if (!instanceId) return false;
            const elasticIp = await findElasticIp(instanceId, region);
            if (!elasticIp) return false;

            // Check if A record exists and points to the right IP
            const existingIp = await findARecord(domain, zoneId, region);
            return existingIp !== elasticIp;
        },
        fix: async (config: FactiiiConfig): Promise<boolean> => {
            const { region } = getAwsConfig(config);
            const projectName = getProjectName(config);
            const environments = extractEnvironments(config);
            const prodEnv = environments.prod ?? environments.production;
            const domain = prodEnv?.domain;
            if (!domain || !isProperDomain(domain)) {
                console.log('   Prod domain not configured — skipping A record');
                return false;
            }

            const zoneId = await findHostedZone(domain, region);
            if (!zoneId) {
                console.log('   Route53 hosted zone must be created first');
                return false;
            }

            const instanceId = await findInstance(projectName, region);
            if (!instanceId) {
                console.log('   EC2 instance must be created first');
                return false;
            }

            const elasticIp = await findElasticIp(instanceId, region);
            if (!elasticIp) {
                console.log('   Elastic IP must be assigned first');
                return false;
            }

            try {
                const r53 = getRoute53Client(region);

                // Create/update A record (UPSERT)
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
                                    ResourceRecords: [{ Value: elasticIp }],
                                },
                            },
                        ],
                    },
                }));

                console.log('   Created A record: ' + domain + ' → ' + elasticIp);
                console.log('   TTL: 300 seconds');
                return true;
            } catch (e) {
                console.log('   Failed to create A record: ' + (e instanceof Error ? e.message : String(e)));
                return false;
            }
        },
        manualFix: 'Create A record: aws route53 change-resource-record-sets --hosted-zone-id ZONE_ID --change-batch ...',
    },
];
