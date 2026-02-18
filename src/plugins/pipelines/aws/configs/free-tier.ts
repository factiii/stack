/**
 * AWS Free Tier Configuration
 *
 * Complete free tier bundle with:
 * - EC2 t2.micro instance
 * - RDS db.t2.micro database
 * - S3 bucket for storage
 * - ECR repository for container images
 */

import type { FactiiiConfig, Fix, DeployResult } from '../../../../types/index.js';
import type { AWSConfigDef } from './types.js';

const freeTierConfig: AWSConfigDef = {
  name: 'free-tier',
  description: 'AWS Free Tier bundle (EC2 + RDS + S3 + ECR)',
  services: ['ec2', 'rds', 's3', 'ecr', 'ses'],

  defaults: {
    instance_type: 't2.micro', // Free tier eligible
    rds_instance: 'db.t2.micro', // Free tier eligible
    storage: 30, // Max free tier EBS
    rds_storage: 20, // Max free tier RDS
    s3_bucket: true,
    ecr_repo: true,
  },

  // ECR fix moved to scanfix/ecr.ts
  fixes: [],

  /**
   * Deploy using this config
   */
  async deploy(_config: FactiiiConfig, _environment: string): Promise<DeployResult> {
    // Free tier deployment includes ECR pull
    return { success: true };
  },

  /**
   * Scan for issues specific to this config
   */
  async scan(config: FactiiiConfig, environment: string): Promise<Fix[]> {
    const issues: Fix[] = [];

    // Run config-specific fixes as scans
    for (const fix of freeTierConfig.fixes) {
      if (fix.stage === environment) {
        const hasProblem = await fix.scan(config, process.cwd());
        if (hasProblem) {
          issues.push(fix);
        }
      }
    }

    return issues;
  },
};

export default freeTierConfig;

