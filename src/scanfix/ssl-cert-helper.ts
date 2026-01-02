/**
 * SSL Certificate Helper Utilities
 *
 * Provides functions for checking certificate existence and validity.
 * Used by certbot scanfix to determine if certs need to be obtained/renewed.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';

export interface CertCheckResult {
  exists: boolean;
  valid: boolean;
  expiresInDays?: number;
  error?: string;
}

/**
 * Check if SSL certificate exists and is valid (not expiring soon)
 *
 * @param domain The domain to check
 * @param warnDays Days before expiration to trigger warning (default: 7)
 * @returns CertCheckResult with existence and validity info
 */
export function checkCertificate(domain: string, warnDays: number = 7): CertCheckResult {
  const certPath = '/etc/letsencrypt/live/' + domain + '/fullchain.pem';

  if (!fs.existsSync(certPath)) {
    return { exists: false, valid: false };
  }

  try {
    // Check if cert is valid for at least warnDays more
    const checkSeconds = warnDays * 24 * 60 * 60;
    execSync('openssl x509 -checkend ' + checkSeconds + ' -noout -in "' + certPath + '"', {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Get exact expiration for reporting
    const expiryOutput = execSync('openssl x509 -enddate -noout -in "' + certPath + '"', {
      encoding: 'utf8',
    });
    const expiryMatch = expiryOutput.match(/notAfter=(.+)/);
    if (expiryMatch && expiryMatch[1]) {
      const expiryDate = new Date(expiryMatch[1]);
      const daysUntilExpiry = Math.floor(
        (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      return { exists: true, valid: true, expiresInDays: daysUntilExpiry };
    }

    return { exists: true, valid: true };
  } catch {
    // openssl returns non-zero if cert expires within checkSeconds
    // Try to get the actual expiry date for the error message
    try {
      const expiryOutput = execSync('openssl x509 -enddate -noout -in "' + certPath + '"', {
        encoding: 'utf8',
      });
      const expiryMatch = expiryOutput.match(/notAfter=(.+)/);
      if (expiryMatch && expiryMatch[1]) {
        const expiryDate = new Date(expiryMatch[1]);
        const daysUntilExpiry = Math.floor(
          (expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );
        return {
          exists: true,
          valid: false,
          expiresInDays: daysUntilExpiry,
          error: 'Certificate expiring in ' + daysUntilExpiry + ' days',
        };
      }
    } catch {
      // Ignore nested error
    }
    return { exists: true, valid: false, error: 'Certificate expiring soon or invalid' };
  }
}

/**
 * Check if nginx container is running
 *
 * @returns true if factiii_nginx container is running
 */
export function isNginxRunning(): boolean {
  try {
    const output = execSync('docker ps --filter name=factiii_nginx --format "{{.Names}}"', {
      encoding: 'utf8',
    });
    return output.trim() === 'factiii_nginx';
  } catch {
    return false;
  }
}
