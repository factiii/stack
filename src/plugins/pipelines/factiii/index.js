/**
 * Factiii Pipeline Plugin
 * 
 * The default pipeline plugin for Factiii Stack.
 * Uses GitHub Actions for CI/CD with thin workflows that SSH to servers
 * and call the Factiii CLI to do the actual work.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

class FactiiiPipeline {
  // ============================================================
  // STATIC METADATA
  // ============================================================
  
  static id = 'factiii';
  static name = 'Factiii Pipeline';
  static category = 'pipeline';
  static version = '1.0.0';
  
  // Env vars this plugin requires (none - pipeline doesn't need app env vars)
  static requiredEnvVars = [];
  
  // Schema for factiii.yml (user-editable)
  static configSchema = {
    // No user config - workflows are auto-generated
  };
  
  // Schema for factiiiAuto.yml (auto-detected)
  static autoConfigSchema = {
    package_manager: 'string',
    node_version: 'string',
    pnpm_version: 'string',
    dockerfile: 'string'
  };
  
  // ============================================================
  // FIXES - All issues this plugin can detect and resolve
  // ============================================================
  
  static fixes = [
    // DEV STAGE FIXES
    {
      id: 'missing-factiii-yml',
      stage: 'dev',
      severity: 'critical',
      description: 'factiii.yml configuration file not found',
      scan: async (config, rootDir) => {
        return !fs.existsSync(path.join(rootDir, 'factiii.yml'));
      },
      fix: async (config, rootDir) => {
        // Generate from plugin schemas
        const { generateFactiiiYml } = require('../../../generators/generate-factiii-yml');
        return generateFactiiiYml(rootDir, { force: false });
      },
      manualFix: 'Run: npx factiii fix (will create factiii.yml from plugin schemas)'
    },
    {
      id: 'missing-workflows',
      stage: 'dev',
      severity: 'warning',
      description: 'GitHub workflows not generated',
      scan: async (config, rootDir) => {
        const workflowsDir = path.join(rootDir, '.github', 'workflows');
        return !fs.existsSync(path.join(workflowsDir, 'factiii-deploy.yml'));
      },
      fix: async (config, rootDir) => {
        await FactiiiPipeline.generateWorkflows(rootDir);
        return true;
      },
      manualFix: 'Run: npx factiii fix (will generate workflow files)'
    },
    {
      id: 'outdated-workflows',
      stage: 'dev',
      severity: 'info',
      description: 'GitHub workflows may be outdated',
      scan: async (config, rootDir) => {
        const workflowPath = path.join(rootDir, '.github', 'workflows', 'factiii-deploy.yml');
        if (!fs.existsSync(workflowPath)) return false;
        
        const content = fs.readFileSync(workflowPath, 'utf8');
        // Check if using old bloated workflow (has inline bash logic)
        return content.includes('docker compose build') || content.length > 5000;
      },
      fix: async (config, rootDir) => {
        await FactiiiPipeline.generateWorkflows(rootDir);
        return true;
      },
      manualFix: 'Run: npx factiii fix (will regenerate thin workflows)'
    },
    
    // SECRETS STAGE FIXES
    {
      id: 'missing-staging-ssh',
      stage: 'secrets',
      severity: 'critical',
      description: 'STAGING_SSH secret not found in GitHub',
      scan: async (config, rootDir) => {
        const { GitHubSecretsStore } = require('../../secrets/github');
        const store = new GitHubSecretsStore({});
        const result = await store.checkSecrets(['STAGING_SSH']);
        return result.missing.includes('STAGING_SSH');
      },
      fix: async (config, rootDir) => {
        // This requires interactive prompting - handled by fix.js
        console.log('   Please provide STAGING_SSH key when prompted');
        return false; // Return false to indicate manual intervention needed
      },
      manualFix: 'Add STAGING_SSH secret at: https://github.com/{owner}/{repo}/settings/secrets/actions'
    },
    {
      id: 'missing-prod-ssh',
      stage: 'secrets',
      severity: 'critical',
      description: 'PROD_SSH secret not found in GitHub',
      scan: async (config, rootDir) => {
        const { GitHubSecretsStore } = require('../../secrets/github');
        const store = new GitHubSecretsStore({});
        const result = await store.checkSecrets(['PROD_SSH']);
        return result.missing.includes('PROD_SSH');
      },
      fix: async (config, rootDir) => {
        console.log('   Please provide PROD_SSH key when prompted');
        return false;
      },
      manualFix: 'Add PROD_SSH secret at: https://github.com/{owner}/{repo}/settings/secrets/actions'
    },
    {
      id: 'missing-aws-secret',
      stage: 'secrets',
      severity: 'warning',
      description: 'AWS_SECRET_ACCESS_KEY not found in GitHub (needed for ECR)',
      scan: async (config, rootDir) => {
        // Only check if AWS is configured
        if (!config?.aws?.access_key_id) return false;
        
        const { GitHubSecretsStore } = require('../../secrets/github');
        const store = new GitHubSecretsStore({});
        const result = await store.checkSecrets(['AWS_SECRET_ACCESS_KEY']);
        return result.missing.includes('AWS_SECRET_ACCESS_KEY');
      },
      fix: async (config, rootDir) => {
        console.log('   Please provide AWS_SECRET_ACCESS_KEY when prompted');
        return false;
      },
      manualFix: 'Add AWS_SECRET_ACCESS_KEY secret at: https://github.com/{owner}/{repo}/settings/secrets/actions'
    }
  ];
  
  // ============================================================
  // STATIC METHODS
  // ============================================================
  
  /**
   * Auto-detect pipeline configuration
   */
  static async detectConfig(rootDir) {
    return {
      package_manager: this.detectPackageManager(rootDir),
      node_version: this.detectNodeVersion(rootDir),
      pnpm_version: this.detectPnpmVersion(rootDir),
      dockerfile: this.findDockerfile(rootDir)
    };
  }
  
  /**
   * Detect package manager
   */
  static detectPackageManager(rootDir) {
    if (fs.existsSync(path.join(rootDir, 'pnpm-lock.yaml'))) {
      return 'pnpm';
    }
    if (fs.existsSync(path.join(rootDir, 'yarn.lock'))) {
      return 'yarn';
    }
    if (fs.existsSync(path.join(rootDir, 'package-lock.json'))) {
      return 'npm';
    }
    return 'npm';
  }
  
  /**
   * Detect Node.js version from package.json
   */
  static detectNodeVersion(rootDir) {
    const packageJsonPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }
    
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (pkg?.engines?.node) {
        const cleaned = pkg.engines.node.replace(/[^0-9.]/g, '');
        return cleaned || null;
      }
    } catch (e) {
      // Ignore errors
    }
    
    return null;
  }
  
  /**
   * Detect pnpm version from package.json
   */
  static detectPnpmVersion(rootDir) {
    const packageJsonPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return null;
    }
    
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      
      if (pkg?.packageManager?.startsWith('pnpm@')) {
        const version = pkg.packageManager.split('@')[1];
        return version.split('.')[0];
      }
      
      if (pkg?.engines?.pnpm) {
        const cleaned = pkg.engines.pnpm.replace(/[^0-9.]/g, '');
        return cleaned.split('.')[0];
      }
    } catch (e) {
      // Ignore errors
    }
    
    return null;
  }
  
  /**
   * Find Dockerfile
   */
  static findDockerfile(rootDir) {
    const commonPaths = [
      'Dockerfile',
      'apps/server/Dockerfile',
      'packages/server/Dockerfile',
      'backend/Dockerfile',
      'server/Dockerfile'
    ];
    
    for (const relativePath of commonPaths) {
      if (fs.existsSync(path.join(rootDir, relativePath))) {
        return relativePath;
      }
    }
    
    return null;
  }
  
  /**
   * Generate GitHub workflow files in the target repository
   */
  static async generateWorkflows(rootDir) {
    const workflowsDir = path.join(rootDir, '.github', 'workflows');
    const sourceDir = path.join(__dirname, 'workflows');
    
    // Create .github/workflows if it doesn't exist
    if (!fs.existsSync(workflowsDir)) {
      fs.mkdirSync(workflowsDir, { recursive: true });
    }
    
    // Copy workflow files
    const workflows = [
      'factiii-deploy.yml',
      'factiii-staging.yml',
      'factiii-production.yml',
      'factiii-undeploy.yml'
    ];
    
    for (const workflow of workflows) {
      const sourcePath = path.join(sourceDir, workflow);
      const destPath = path.join(workflowsDir, workflow);
      
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath);
        console.log(`   ✅ Generated ${workflow}`);
      }
    }
  }
  
  /**
   * Trigger a GitHub Actions workflow
   */
  static async triggerWorkflow(workflowName, inputs = {}) {
    const { GitHubSecretsStore } = require('../../secrets/github');
    const repoInfo = GitHubSecretsStore.getRepoInfo();
    
    if (!repoInfo) {
      throw new Error('Could not determine GitHub repository');
    }
    
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      throw new Error('GITHUB_TOKEN required to trigger workflows');
    }
    
    const { Octokit } = require('@octokit/rest');
    const octokit = new Octokit({ auth: token });
    
    await octokit.rest.actions.createWorkflowDispatch({
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      workflow_id: workflowName,
      ref: 'main',
      inputs
    });
  }
  
  // ============================================================
  // INSTANCE METHODS
  // ============================================================
  
  constructor(config = {}) {
    this.config = config;
  }
  
  /**
   * Deploy to an environment
   * For pipeline plugins, this triggers the deployment process
   */
  async deploy(config, environment) {
    if (environment === 'dev') {
      // Dev doesn't use pipeline - handled by server plugin
      return { success: true, message: 'Dev deploy handled by server plugin' };
    }
    
    // For staging/prod, we're already ON the server (called via SSH from workflow)
    // The pipeline plugin doesn't do the actual deployment - server plugins do
    console.log(`   Pipeline: ${environment} deployment initiated`);
    return { success: true };
  }
  
  /**
   * Undeploy from an environment
   */
  async undeploy(config, environment) {
    console.log(`   Pipeline: ${environment} undeploy initiated`);
    return { success: true };
  }
}

module.exports = FactiiiPipeline;
