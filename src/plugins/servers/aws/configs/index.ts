/**
 * AWS Configs Index
 *
 * Exports all available AWS configuration types.
 * Configs are selected based on `config.aws.config` value in factiii.yml.
 *
 * Available configs:
 * - ec2: Basic EC2 instance
 * - free-tier: Complete free tier bundle (EC2 + RDS + S3 + ECR)
 */

export { default as ec2 } from './ec2.js';
export { default as freeTier } from './free-tier.js';
export type { AWSConfigDef } from './types.js';

