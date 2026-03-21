/**
 * Vercel Custom Domain Scanfix
 *
 * Configures custom domain on the Vercel project via API.
 * Runs after DNS records are set up (dns.ts).
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { extractEnvironments } from '../../../../utils/config-helpers.js';

/**
 * Get the root domain from a subdomain (e.g., api.facti.us → facti.us)
 */
function getRootDomain(domain: string): string {
    const parts = domain.split('.');
    if (parts.length <= 2) return domain;
    return parts.slice(-2).join('.');
}

/**
 * Get the Vercel domain from config
 */
function getVercelDomain(config: FactiiiConfig): string | null {
    const vercelDomain = (config.vercel as Record<string, unknown> | null)?.domain as string | undefined;
    if (vercelDomain && !vercelDomain.toUpperCase().startsWith('EXAMPLE')) return vercelDomain;

    const environments = extractEnvironments(config);
    const prodEnv = environments.prod ?? environments.production;
    const prodDomain = prodEnv?.domain;
    if (!prodDomain || prodDomain.toUpperCase().startsWith('EXAMPLE')) return null;

    return getRootDomain(prodDomain);
}

export const domainFixes: Fix[] = [
    {
        id: 'vercel-custom-domain',
        stage: 'prod',
        severity: 'warning',
        description: '🌐 Custom domain not configured on Vercel project',
        scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
            if (config.vercel === undefined) return false;

            const projectId = (config.vercel as Record<string, unknown> | null)?.project_id as string | undefined;
            if (!projectId) return false;

            const domain = getVercelDomain(config);
            if (!domain) return false;

            try {
                const { getVercelToken, listProjectDomains } =
                    await import('../utils/vercel-api.js');
                const token = await getVercelToken(config, rootDir);
                const orgId = (config.vercel as Record<string, unknown> | null)?.org_id as string | undefined;

                const domains = await listProjectDomains(token, projectId, orgId);
                const hasCustomDomain = domains.some(d => d.name === domain || d.name === 'www.' + domain);
                return !hasCustomDomain;
            } catch {
                return false; // Token or API not available, skip
            }
        },
        fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
            const projectId = (config.vercel as Record<string, unknown> | null)?.project_id as string | undefined;
            if (!projectId) {
                console.log('   Vercel project not configured — run: npx stack fix --dev');
                return false;
            }

            const domain = getVercelDomain(config);
            if (!domain) {
                console.log('   No domain configured for Vercel');
                return false;
            }

            try {
                const { getVercelToken, addProjectDomain } =
                    await import('../utils/vercel-api.js');
                const token = await getVercelToken(config, rootDir);
                const orgId = (config.vercel as Record<string, unknown> | null)?.org_id as string | undefined;

                // Add root domain
                console.log('   Adding ' + domain + ' to Vercel project...');
                const rootAdded = await addProjectDomain(token, projectId, domain, orgId);
                if (rootAdded) {
                    console.log('   [OK] Added ' + domain);
                }

                // Add www subdomain
                console.log('   Adding www.' + domain + ' to Vercel project...');
                const wwwAdded = await addProjectDomain(token, projectId, 'www.' + domain, orgId);
                if (wwwAdded) {
                    console.log('   [OK] Added www.' + domain);
                }

                console.log('   Vercel will auto-provision SSL certificates.');
                return true;
            } catch (e) {
                console.log('   Failed to add domain: ' + (e instanceof Error ? e.message : String(e)));
                return false;
            }
        },
        manualFix: 'Add domain in Vercel dashboard: Project → Settings → Domains → Add your domain',
    },
];
