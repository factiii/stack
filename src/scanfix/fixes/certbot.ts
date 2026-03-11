/**
 * Shared Certbot Fixes
 *
 * SSL certificate acquisition and renewal using Docker certbot.
 * Used by mac, ubuntu, and aws plugins.
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
        ? ((config as Record<string, unknown>).production as Record<string, unknown> | undefined)?.domain as string | undefined
        : ((config as Record<string, unknown>)[envKey] as Record<string, unknown> | undefined)?.domain as string | undefined;

      if (!domain || domain.toUpperCase().startsWith('EXAMPLE')) return false;

      // Skip SSL for IP addresses (certs only work with domain names)
      if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) return false;

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
        ? ((config as Record<string, unknown>).production as Record<string, unknown> | undefined)?.domain as string | undefined
        : ((config as Record<string, unknown>)[envKey] as Record<string, unknown> | undefined)?.domain as string | undefined;
      const envObj = (config as Record<string, unknown>)[envKey] as Record<string, unknown> | undefined;
      const sslEmail = (envObj?.ssl_email as string | undefined) ?? config.ssl_email;

      if (!domain) {
        console.log('   No ' + stageLabel + ' domain configured');
        return false;
      }

      if (!sslEmail) {
        console.log('   No ssl_email configured in stack.yml');
        console.log('   Add ssl_email: your@email.com to your environment config in stack.yml');
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

        // Capture both stdout AND stderr (certbot writes renewal info to stderr)
        let fullOutput = '';
        try {
          fullOutput = execSync(certbotCmd + ' 2>&1', { encoding: 'utf8' }) || '';
        } catch (cmdErr) {
          // execSync throws on non-zero exit, but output may still be useful
          const cmdMsg = cmdErr instanceof Error ? (cmdErr as any).stdout || (cmdErr as any).stderr || cmdErr.message : String(cmdErr);
          if (typeof cmdMsg === 'string' &&
              (cmdMsg.includes('not yet due for renewal') || cmdMsg.includes('no action taken'))) {
            console.log('   [OK] SSL certificate is valid and not yet due for renewal');
            return true;
          }
          fullOutput = typeof cmdMsg === 'string' ? cmdMsg : '';
        }

        // "Certificate not yet due for renewal" means cert already exists and is valid
        if (fullOutput.includes('not yet due for renewal') || fullOutput.includes('Certificate not yet due') || fullOutput.includes('no action taken')) {
          console.log('   [OK] SSL certificate is valid and not yet due for renewal');
          return true;
        }

        // Verify certificate was created and is valid
        const certResult = checkCertificate(domain);
        if (!certResult.exists || !certResult.valid) {
          // Double-check: cert might actually be valid but certbot output went to stderr/docker TTY
          const recheck = checkCertificate(domain, 7);
          if (recheck.exists && recheck.valid) {
            console.log('   [OK] SSL certificate is valid (expires in ' + recheck.expiresInDays + ' days)');
            return true;
          }
          // Final check: try openssl s_client to verify cert is actually serving
          try {
            const sslCheck = execSync(
              'echo | openssl s_client -connect ' + domain + ':443 -servername ' + domain + ' 2>/dev/null | openssl x509 -noout -dates 2>/dev/null',
              { encoding: 'utf8', timeout: 10000 }
            );
            if (sslCheck.includes('notAfter')) {
              console.log('   [OK] SSL certificate is serving correctly on ' + domain);
              return true;
            }
          } catch { /* ignore — cert may not be serving yet */ }
          console.log('   Certificate was not created or is invalid');
          return false;
        }

        console.log('   [OK] SSL certificate obtained successfully');

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
        // Check if the error output contains renewal message (certbot exits 0 but stderr has info)
        if (errorMessage.includes('not yet due for renewal') || errorMessage.includes('no action taken')) {
          console.log('   [OK] SSL certificate is valid and not yet due for renewal');
          return true;
        }
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
