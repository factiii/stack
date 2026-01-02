/**
 * Shared Certbot Fixes
 *
 * SSL certificate acquisition and renewal using Docker certbot.
 * Used by mac-mini and aws plugins.
 */

import { execSync } from 'child_process';
import type { Fix, Stage, FactiiiConfig } from '../../types/index.js';
import { checkCertificate, isNginxRunning } from '../ssl-cert-helper.js';

type EnvKey = 'staging' | 'prod' | 'production';

/**
 * Create SSL certificate fix for a specific stage
 *
 * @param stage The stage (staging or prod)
 * @param envKey The environment key in config (staging, prod, or production)
 */
export function createCertbotFix(stage: Stage, envKey: EnvKey): Fix {
  const stageLabel = stage === 'staging' ? 'staging' : 'production';

  return {
    id: stage + '-ssl-certs-missing-or-expiring',
    stage,
    severity: 'warning',
    description: 'SSL certificates missing or expiring soon for ' + stageLabel + ' domain',

    scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const domain = envKey === 'production'
        ? config?.environments?.production?.domain
        : config?.environments?.[envKey]?.domain;

      if (!domain || domain.startsWith('EXAMPLE-')) return false;

      const result = checkCertificate(domain, 7);
      if (!result.exists) {
        console.log('   No SSL certificate for ' + domain);
        return true;
      }
      if (!result.valid) {
        console.log('   SSL certificate for ' + domain + ' expires in ' + result.expiresInDays + ' days');
        return true;
      }
      return false;
    },

    fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
      const domain = envKey === 'production'
        ? config?.environments?.production?.domain
        : config?.environments?.[envKey]?.domain;
      const sslEmail = config.ssl_email;

      if (!domain) {
        console.log('   No ' + stageLabel + ' domain configured');
        return false;
      }

      if (!sslEmail) {
        console.log('   No ssl_email configured in factiii.yml');
        console.log('   Add ssl_email: your@email.com to factiii.yml');
        return false;
      }

      try {
        const nginxRunning = isNginxRunning();
        console.log('   Obtaining SSL certificate for ' + domain + ' via Docker...');

        let certbotCmd: string;

        if (nginxRunning) {
          // Webroot mode: nginx is running, use it for ACME challenge
          console.log('   Using webroot mode (nginx is running)');
          certbotCmd = [
            'docker run --rm',
            '-v /etc/letsencrypt:/etc/letsencrypt',
            '-v /var/www/certbot:/var/www/certbot',
            'certbot/certbot certonly',
            '--webroot -w /var/www/certbot',
            '-d ' + domain,
            '--email ' + sslEmail,
            '--agree-tos',
            '--non-interactive',
          ].join(' ');
        } else {
          // Standalone mode: nginx not running, certbot handles port 80
          console.log('   Using standalone mode (nginx not running)');
          certbotCmd = [
            'docker run --rm',
            '-v /etc/letsencrypt:/etc/letsencrypt',
            '-p 80:80',
            'certbot/certbot certonly',
            '--standalone',
            '-d ' + domain,
            '--email ' + sslEmail,
            '--agree-tos',
            '--non-interactive',
          ].join(' ');
        }

        execSync(certbotCmd, { stdio: 'inherit' });

        // Verify certificate was created and is valid
        const certResult = checkCertificate(domain);
        if (!certResult.exists || !certResult.valid) {
          console.log('   Certificate was not created or is invalid');
          return false;
        }

        console.log('   SSL certificate obtained successfully');

        // Reload nginx if running (it will pick up new certs)
        if (nginxRunning) {
          console.log('   Reloading nginx...');
          try {
            execSync('docker exec factiii_nginx nginx -s reload', { stdio: 'inherit' });
            console.log('   Nginx reloaded with new certificate');
          } catch {
            console.log('   Could not reload nginx - restart may be needed');
            console.log('   Run: docker restart factiii_nginx');
          }
        }

        return true;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        console.log('   Failed to obtain certificate: ' + errorMessage);
        console.log('   Make sure port 80 is accessible and not in use');
        return false;
      }
    },

    manualFix: 'Run: docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -p 80:80 certbot/certbot certonly --standalone -d {domain} --email {ssl_email} --agree-tos --non-interactive',
  };
}

/**
 * Get certbot fix for staging
 */
export function getStagingCertbotFix(): Fix {
  return createCertbotFix('staging', 'staging');
}

/**
 * Get certbot fix for production
 */
export function getProdCertbotFix(): Fix {
  return createCertbotFix('prod', 'prod');
}
