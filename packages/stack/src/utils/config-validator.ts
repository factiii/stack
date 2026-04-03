/**
 * Config Validator
 *
 * Validates stack.yml configuration and workflow sync.
 */

import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';

import { getStackConfigPath } from '../constants/config-files.js';
import type { FactiiiConfig, EnvironmentConfig } from '../types/index.js';

interface WorkflowConfig {
  environments: Record<string, Partial<EnvironmentConfig>>;
  repoName: string | null;
}

interface ValidationResult {
  valid: boolean;
  error?: string;
  drift?: boolean;
  message?: string;
  needsGeneration?: boolean;
  needsRegeneration?: boolean;
  mismatches?: string[];
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface WorkflowStep {
  run?: string;
}

interface Workflow {
  jobs?: {
    deploy?: WorkflowJob;
  };
}

/**
 * Extract config values from workflow file
 */
export function extractWorkflowConfig(workflowPath: string): WorkflowConfig | null {
  if (!fs.existsSync(workflowPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(workflowPath, 'utf8');
    const workflow = yaml.load(content) as Workflow | null;

    // Extract relevant config from workflow
    // Look for yq commands that read from stack.yml
    const config: WorkflowConfig = {
      environments: {},
      repoName: null,
    };

    // Parse the workflow to find config reads
    // This is a simplified version - you may need to adjust based on actual workflow structure
    const jobSteps = workflow?.jobs?.deploy?.steps ?? [];

    for (const step of jobSteps) {
      if (step.run && step.run.includes('yq eval')) {
        // Extract what config values the workflow expects
        // e.g., "yq eval '.staging.host'"
        const hostMatch = step.run.match(/\.(\w+)\.host/);
        if (hostMatch && hostMatch[1]) {
          const envName = hostMatch[1];
          // Skip reserved config keys
          if (!['name', 'config_version', 'github_repo', 'ssl_email', 'pipeline', 'prisma_schema', 'prisma_version', 'container_exclusions', 'trusted_plugins'].includes(envName)) {
            if (!config.environments[envName]) {
              config.environments[envName] = {};
            }
          }
        }
      }
    }

    return config;
  } catch {
    return null;
  }
}

/**
 * Compare stack.yml with generated workflows
 */
export function validateConfigSync(rootDir: string): ValidationResult {
  const configPath = getStackConfigPath(rootDir);
  const workflowPath = path.join(rootDir, '.github/workflows/stack-deploy.yml');

  if (!fs.existsSync(configPath)) {
    return { valid: false, error: 'stack.yml not found' };
  }

  if (!fs.existsSync(workflowPath)) {
    return { valid: false, error: 'Workflows not generated', needsGeneration: true };
  }

  try {
    const config = yaml.load(fs.readFileSync(configPath, 'utf8')) as FactiiiConfig;

    // Check if workflow file is older than config file
    const configStat = fs.statSync(configPath);
    const workflowStat = fs.statSync(workflowPath);

    const configNewer = configStat.mtimeMs > workflowStat.mtimeMs;

    if (configNewer) {
      return {
        valid: false,
        drift: true,
        message: 'Config modified after workflows were generated',
        needsRegeneration: true,
      };
    }

    // Additional validation: check if workflow references match config
    const workflowContent = fs.readFileSync(workflowPath, 'utf8');
    const mismatches: string[] = [];

    // Extract environments from config (top-level keys)
    const { extractEnvironments } = require('./config-helpers.js');
    const environments = extractEnvironments(config);

    // Check if all environments in config have corresponding workflow logic
    for (const envName of Object.keys(environments)) {
      // Check if workflow mentions this environment
      if (!workflowContent.includes(`environment == '${envName}'`)) {
        mismatches.push(`Environment '${envName}' not found in workflow`);
      }
    }

    if (mismatches.length > 0) {
      return {
        valid: false,
        drift: true,
        mismatches,
        needsRegeneration: true,
      };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

