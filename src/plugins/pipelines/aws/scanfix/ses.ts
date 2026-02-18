/**
 * AWS SES Fixes
 *
 * Configures Simple Email Service for transactional email.
 * Handles domain verification, DKIM setup, and sandbox status.
 */

import type { FactiiiConfig, Fix } from '../../../../types/index.js';
import { awsExec, awsExecSafe, getAwsConfig } from '../utils/aws-helpers.js';

/**
 * Get the production domain from config
 */
function getProdDomain(config: FactiiiConfig): string | null {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { extractEnvironments } = require('../../../../utils/config-helpers.js');
  const environments = extractEnvironments(config);
  const prodEnv = environments.prod ?? environments.production;
  const domain = prodEnv?.domain;
  if (!domain || domain.startsWith('EXAMPLE-')) return null;
  return domain;
}

/**
 * Check if domain is verified in SES
 */
function isDomainVerified(domain: string, region: string): boolean {
  const result = awsExecSafe(
    'aws ses get-identity-verification-attributes --identities ' + domain +
    ' --query "VerificationAttributes.' + domain + '.VerificationStatus" --output text',
    region
  );
  return result === 'Success';
}

/**
 * Check if DKIM is configured for domain
 */
function hasDkim(domain: string, region: string): boolean {
  const result = awsExecSafe(
    'aws ses get-identity-dkim-attributes --identities ' + domain +
    ' --query "DkimAttributes.' + domain + '.DkimEnabled" --output text',
    region
  );
  return result === 'true' || result === 'True';
}

/**
 * Check if AWS is configured for this project
 */
function isAwsConfigured(config: FactiiiConfig): boolean {
  if (config.aws) return true;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { extractEnvironments } = require('../../../../utils/config-helpers.js');
  const environments = extractEnvironments(config);
  return Object.values(environments).some(
    (e: unknown) => (e as { pipeline?: string }).pipeline === 'aws'
  );
}

export const sesFixes: Fix[] = [
  {
    id: 'aws-ses-domain-missing',
    stage: 'prod',
    severity: 'warning',
    description: 'SES domain identity not verified for email',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const domain = getProdDomain(config);
      if (!domain) return false;
      return !isDomainVerified(domain, region);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const domain = getProdDomain(config);
      if (!domain) {
        console.log('   Set production domain in factiii.yml first');
        return false;
      }

      try {
        // Start domain verification
        awsExec(
          'aws ses verify-domain-identity --domain ' + domain,
          region
        );

        // Get the verification token
        const tokenResult = awsExec(
          'aws ses get-identity-verification-attributes --identities ' + domain +
          ' --query "VerificationAttributes.' + domain + '.VerificationToken" --output text',
          region
        );
        const token = tokenResult.replace(/"/g, '');

        console.log('   Started domain verification for: ' + domain);
        console.log('');
        console.log('   Add this TXT record to your DNS:');
        console.log('   Name:  _amazonses.' + domain);
        console.log('   Type:  TXT');
        console.log('   Value: ' + token);
        console.log('');
        console.log('   Verification may take a few minutes after DNS propagation.');

        return true;
      } catch (e) {
        console.log('   Failed to start domain verification: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Verify domain in SES: aws ses verify-domain-identity --domain <domain>\nThen add the TXT record to DNS',
  },
  {
    id: 'aws-ses-dkim-missing',
    stage: 'prod',
    severity: 'info',
    description: 'SES DKIM not configured (improves email deliverability)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const domain = getProdDomain(config);
      if (!domain) return false;
      if (!isDomainVerified(domain, region)) return false; // Domain must be verified first
      return !hasDkim(domain, region);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const { region } = getAwsConfig(config);
      const domain = getProdDomain(config);
      if (!domain) return false;

      try {
        // Generate DKIM tokens
        const result = awsExec(
          'aws ses verify-domain-dkim --domain ' + domain,
          region
        );
        const parsed = JSON.parse(result);
        const tokens: string[] = parsed.DkimTokens ?? [];

        console.log('   Generated DKIM tokens for: ' + domain);
        console.log('');
        console.log('   Add these CNAME records to your DNS:');
        for (const token of tokens) {
          console.log('   Name:  ' + token + '._domainkey.' + domain);
          console.log('   Type:  CNAME');
          console.log('   Value: ' + token + '.dkim.amazonses.com');
          console.log('');
        }
        console.log('   DKIM verification may take a few minutes after DNS propagation.');

        return true;
      } catch (e) {
        console.log('   Failed to configure DKIM: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Configure DKIM: aws ses verify-domain-dkim --domain <domain>\nThen add CNAME records to DNS',
  },
  {
    id: 'aws-ses-sandbox',
    stage: 'prod',
    severity: 'info',
    description: 'SES is in sandbox mode (can only send to verified emails)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (!isAwsConfigured(config)) return false;
      const { region } = getAwsConfig(config);
      const domain = getProdDomain(config);
      if (!domain) return false;
      if (!isDomainVerified(domain, region)) return false;

      // Check sending quota — sandbox has max 200/day
      const result = awsExecSafe(
        'aws ses get-send-quota --query "Max24HourSend" --output text',
        region
      );
      if (!result) return false;
      const maxSend = parseFloat(result);
      return maxSend <= 200; // Sandbox limit
    },
    fix: null,
    manualFix: [
      'SES is in sandbox mode. To send to unverified emails:',
      '',
      '1. Go to AWS Console → SES → Account dashboard',
      '2. Click "Request production access"',
      '3. Fill in the form with your use case',
      '4. AWS typically approves within 24 hours',
    ].join('\n'),
  },
];
