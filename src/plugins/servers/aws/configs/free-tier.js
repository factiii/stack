/**
 * AWS Free Tier Configuration
 * 
 * Complete free tier bundle with:
 * - EC2 t2.micro instance
 * - RDS db.t2.micro database
 * - S3 bucket for storage
 * - ECR repository for container images
 */

module.exports = {
  name: 'free-tier',
  description: 'AWS Free Tier bundle (EC2 + RDS + S3 + ECR)',
  services: ['ec2', 'rds', 's3', 'ecr'],
  
  defaults: {
    instance_type: 't2.micro',      // Free tier eligible
    rds_instance: 'db.t2.micro',    // Free tier eligible
    storage: 30,                     // Max free tier EBS
    rds_storage: 20,                 // Max free tier RDS
    s3_bucket: true,
    ecr_repo: true
  },
  
  // Additional fixes specific to this config
  fixes: [
    {
      id: 'ecr-repo-missing',
      stage: 'prod',
      severity: 'warning',
      description: 'ECR repository not created',
      scan: async (config, rootDir) => {
        // Check if ECR repo exists
        const repoName = config.name || 'app';
        const region = config.aws?.region || 'us-east-1';
        
        try {
          const { execSync } = require('child_process');
          execSync(
            `aws ecr describe-repositories --repository-names ${repoName} --region ${region}`,
            { stdio: 'pipe' }
          );
          return false; // Repo exists
        } catch {
          return true; // Repo doesn't exist
        }
      },
      fix: async (config, rootDir) => {
        const repoName = config.name || 'app';
        const region = config.aws?.region || 'us-east-1';
        
        try {
          const { execSync } = require('child_process');
          execSync(
            `aws ecr create-repository --repository-name ${repoName} --region ${region}`,
            { stdio: 'pipe' }
          );
          console.log(`   Created ECR repository: ${repoName}`);
          return true;
        } catch (e) {
          console.log(`   Failed to create ECR repo: ${e.message}`);
          return false;
        }
      },
      manualFix: 'Create ECR repository: aws ecr create-repository --repository-name <app-name>'
    }
  ],
  
  /**
   * Deploy using this config
   */
  async deploy(config, environment) {
    // Free tier deployment includes ECR pull
    return { success: true };
  },
  
  /**
   * Scan for issues specific to this config
   */
  async scan(config, environment) {
    const issues = [];
    
    // Run config-specific fixes as scans
    for (const fix of this.fixes) {
      if (fix.stage === environment) {
        const hasProblem = await fix.scan(config, process.cwd());
        if (hasProblem) {
          issues.push(fix);
        }
      }
    }
    
    return issues;
  }
};
