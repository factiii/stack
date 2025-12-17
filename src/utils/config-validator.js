const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

/**
 * Extract config values from workflow file
 */
function extractWorkflowConfig(workflowPath) {
  if (!fs.existsSync(workflowPath)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(workflowPath, 'utf8');
    const workflow = yaml.load(content);
    
    // Extract relevant config from workflow
    // Look for yq commands that read from factiii.yml
    const config = {
      environments: {},
      repoName: null
    };
    
    // Parse the workflow to find config reads
    // This is a simplified version - you may need to adjust based on actual workflow structure
    const jobSteps = workflow.jobs?.deploy?.steps || [];
    
    for (const step of jobSteps) {
      if (step.run && step.run.includes('yq eval')) {
        // Extract what config values the workflow expects
        // e.g., "yq eval '.environments.staging.host'"
        const hostMatch = step.run.match(/\.environments\.(\w+)\.host/);
        if (hostMatch) {
          const envName = hostMatch[1];
          if (!config.environments[envName]) {
            config.environments[envName] = {};
          }
        }
      }
    }
    
    return config;
  } catch (error) {
    return null;
  }
}

/**
 * Compare factiii.yml with generated workflows
 */
function validateConfigSync(rootDir) {
  const configPath = path.join(rootDir, 'factiii.yml');
  const workflowPath = path.join(rootDir, '.github/workflows/factiii-deploy.yml');
  
  if (!fs.existsSync(configPath)) {
    return { valid: false, error: 'factiii.yml not found' };
  }
  
  if (!fs.existsSync(workflowPath)) {
    return { valid: false, error: 'Workflows not generated', needsGeneration: true };
  }
  
  try {
    const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
    
    // Check if workflow file is older than config file
    const configStat = fs.statSync(configPath);
    const workflowStat = fs.statSync(workflowPath);
    
    const configNewer = configStat.mtimeMs > workflowStat.mtimeMs;
    
    if (configNewer) {
      return {
        valid: false,
        drift: true,
        message: 'factiii.yml modified after workflows were generated',
        needsRegeneration: true
      };
    }
    
    // Additional validation: check if workflow references match config
    const workflowContent = fs.readFileSync(workflowPath, 'utf8');
    const mismatches = [];
    
    // Check if all environments in config have corresponding workflow logic
    if (config.environments) {
      for (const envName of Object.keys(config.environments)) {
        // Check if workflow mentions this environment
        if (!workflowContent.includes(`environment == '${envName}'`)) {
          mismatches.push(`Environment '${envName}' not found in workflow`);
        }
      }
    }
    
    if (mismatches.length > 0) {
      return {
        valid: false,
        drift: true,
        mismatches,
        needsRegeneration: true
      };
    }
    
    return { valid: true };
    
  } catch (error) {
    return { valid: false, error: error.message };
  }
}

module.exports = {
  extractWorkflowConfig,
  validateConfigSync
};
