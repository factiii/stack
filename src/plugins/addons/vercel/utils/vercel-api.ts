/**
 * Vercel API Utilities
 *
 * API-first integration with Vercel for deployments.
 * Uses Vercel REST API exclusively (no CLI required).
 *
 * Vercel API Docs: https://vercel.com/docs/rest-api
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import type { FactiiiConfig, DeployResult } from '../../../../types/index.js';
import { getDefaultVaultPath } from '../../../../utils/config-helpers.js';

interface VercelProject {
  id: string;
  name: string;
  orgId?: string;
}

interface VercelDeployment {
  id: string;
  url: string;
  state: 'BUILDING' | 'READY' | 'ERROR' | 'CANCELED';
  readyState: 'READY' | 'ERROR' | 'BUILDING' | 'QUEUED' | 'CANCELED';
  target: 'production' | 'staging' | 'preview';
}

interface DeployOptions {
  production?: boolean;
  branch?: string;
  commit?: string;
}

/**
 * Get VERCEL_TOKEN from vault or environment
 */
export async function getVercelToken(config: FactiiiConfig, rootDir: string): Promise<string> {
  // Check environment first
  if (process.env.VERCEL_TOKEN) {
    return process.env.VERCEL_TOKEN;
  }

  // Read from Ansible Vault
  const { AnsibleVaultSecrets } = await import('../../../../utils/ansible-vault-secrets.js');
  const vault = new AnsibleVaultSecrets({
    vault_path: (config.ansible?.vault_path as string) || getDefaultVaultPath(config),
    vault_password_file: config.ansible?.vault_password_file as string | undefined,
    rootDir,
  });

  const token = await vault.getSecret('VERCEL_TOKEN');
  if (!token) {
    throw new Error('VERCEL_TOKEN not found in vault or environment');
  }

  return token;
}

/**
 * Get git repository info
 */
function getGitInfo(rootDir: string): { repo: string; branch: string; commit: string } | null {
  try {
    const remote = execSync('git remote get-url origin', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const branch = execSync('git branch --show-current', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const commit = execSync('git rev-parse HEAD', {
      cwd: rootDir,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    if (!match || !match[1]) {
      return null;
    }

    return { repo: match[1], branch, commit };
  } catch {
    return null;
  }
}

/**
 * Call Vercel API
 */
async function callVercelAPI(
  endpoint: string,
  token: string,
  options: {
    method?: string;
    body?: unknown;
    teamId?: string;
  } = {}
): Promise<unknown> {
  const { method = 'GET', body, teamId } = options;

  let url = 'https://api.vercel.com' + endpoint;
  if (teamId && !url.includes('?')) {
    url = url + '?teamId=' + teamId;
  } else if (teamId) {
    url = url + '&teamId=' + teamId;
  }

  const headers: Record<string, string> = {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
  };

  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  if (body) {
    fetchOptions.body = JSON.stringify(body);
  }

  const response = await fetch(url, fetchOptions);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error('Vercel API error (' + response.status + '): ' + errorText);
  }

  return await response.json();
}

/**
 * Get user's Vercel teams (to resolve 403 errors)
 */
export async function getVercelTeams(
  token: string
): Promise<{ id: string; name: string; slug: string }[]> {
  try {
    const result = (await callVercelAPI('/v2/teams', token)) as {
      teams?: { id: string; name: string; slug: string }[];
    };
    return result.teams ?? [];
  } catch {
    return [];
  }
}

/**
 * List all Vercel projects for the authenticated user/team.
 * If no teamId is provided and we get 403, auto-discovers teams and retries.
 */
export async function listVercelProjects(
  token: string,
  teamId?: string
): Promise<{ id: string; name: string; orgId?: string }[]> {
  try {
    const result = (await callVercelAPI('/v10/projects?limit=100', token, { teamId })) as {
      projects?: { id: string; name: string; accountId?: string }[];
    };
    return (result.projects ?? []).map(p => ({
      id: p.id,
      name: p.name,
      orgId: p.accountId ?? teamId,
    }));
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);

    if (errorMsg.includes('403') && !teamId) {
      const teams = await getVercelTeams(token);
      if (teams.length > 0) {
        const team = teams[0]!;
        console.log('   Token is team-scoped, trying team: ' + team.name);
        const result = (await callVercelAPI('/v10/projects?limit=100', token, { teamId: team.id })) as {
          projects?: { id: string; name: string; accountId?: string }[];
        };
        return (result.projects ?? []).map(p => ({
          id: p.id,
          name: p.name,
          orgId: p.accountId ?? team.id,
        }));
      }
    }

    throw e;
  }
}

/**
 * Find a Vercel project by name (case-insensitive match)
 */
export async function findVercelProject(
  token: string,
  projectName: string,
  teamId?: string
): Promise<{ id: string; name: string; orgId?: string } | null> {
  const projects = await listVercelProjects(token, teamId);
  const normalizedName = projectName.toLowerCase();
  return projects.find(p => p.name.toLowerCase() === normalizedName) ?? null;
}

/**
 * Create a new Vercel project via API
 */
export async function createVercelProject(
  token: string,
  name: string,
  options: { teamId?: string; gitRepo?: string; framework?: string } = {}
): Promise<{ id: string; name: string; orgId?: string }> {
  const body: Record<string, unknown> = { name };

  if (options.gitRepo) {
    body.gitRepository = {
      type: 'github',
      repo: options.gitRepo,
    };
  }

  if (options.framework) {
    body.framework = options.framework;
  }

  const result = (await callVercelAPI('/v9/projects', token, {
    method: 'POST',
    body,
    teamId: options.teamId,
  })) as { id: string; name: string; accountId?: string };

  return {
    id: result.id,
    name: result.name,
    orgId: result.accountId ?? options.teamId,
  };
}

/**
 * Deploy to Vercel via Create Deployment API.
 *
 * Uses POST /v13/deployments to trigger a git-based deployment.
 * Polls for completion and returns the result.
 */
export async function deployToVercel(
  config: FactiiiConfig,
  options: DeployOptions = {}
): Promise<DeployResult> {
  const rootDir = process.cwd();

  try {
    console.log('   Deploying to Vercel via API...');

    const token = await getVercelToken(config, rootDir);

    // Get project info from stack.yml config (preferred) or .vercel/project.json (fallback)
    let projectId = config.vercel?.project_id as string | undefined;
    let projectName = config.vercel?.project_name as string | undefined;
    let orgId = config.vercel?.org_id as string | undefined;

    if (!projectId) {
      // Fallback: read from .vercel/project.json
      const vercelConfigPath = path.join(rootDir, '.vercel', 'project.json');
      if (fs.existsSync(vercelConfigPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(vercelConfigPath, 'utf8'));
          projectId = data.projectId;
          orgId = orgId ?? data.orgId;
        } catch { /* ignore */ }
      }
    }

    if (!projectId && projectName) {
      // Look up project ID by name
      const project = await findVercelProject(token, projectName, orgId);
      if (project) {
        projectId = project.id;
        orgId = orgId ?? project.orgId;
      }
    }

    if (!projectId) {
      return {
        success: false,
        error: 'Vercel project not configured. Run: npx stack fix',
      };
    }

    // Get git info for the deployment
    const gitInfo = getGitInfo(rootDir);
    if (!gitInfo) {
      return {
        success: false,
        error: 'Git repository not found or not a GitHub repo',
      };
    }

    const targetBranch = options.branch || gitInfo.branch;
    const isProduction = options.production ?? (targetBranch === 'main' || targetBranch === 'master');

    console.log('   Project: ' + (projectName ?? projectId));
    console.log('   Branch: ' + targetBranch);
    console.log('   Target: ' + (isProduction ? 'production' : 'preview'));

    // Create deployment via Vercel API
    const deployBody: Record<string, unknown> = {
      name: projectName ?? config.name ?? 'app',
      project: projectId,
      target: isProduction ? 'production' : undefined,
      gitSource: {
        type: 'github',
        repo: gitInfo.repo,
        ref: targetBranch,
        sha: options.commit || gitInfo.commit,
      },
    };

    console.log('   Triggering deployment...');
    const deployment = (await callVercelAPI('/v13/deployments', token, {
      method: 'POST',
      body: deployBody,
      teamId: orgId,
    })) as { id: string; url: string; readyState: string };

    console.log('   Deployment created: ' + deployment.id);
    console.log('   URL: https://' + deployment.url);

    // Poll for deployment completion (max 5 minutes)
    const maxWait = 300000;
    const pollInterval = 5000;
    const startTime = Date.now();
    let finalState = deployment.readyState;

    while (Date.now() - startTime < maxWait) {
      if (finalState === 'READY' || finalState === 'ERROR' || finalState === 'CANCELED') {
        break;
      }

      await new Promise(r => setTimeout(r, pollInterval));

      try {
        const status = (await callVercelAPI('/v13/deployments/' + deployment.id, token, {
          teamId: orgId,
        })) as { readyState: string; url: string };
        finalState = status.readyState;

        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        console.log('   [' + elapsed + 's] Status: ' + finalState);
      } catch {
        break;
      }
    }

    if (finalState === 'READY') {
      return {
        success: true,
        message: 'Deployed to Vercel: https://' + deployment.url,
      };
    }

    if (finalState === 'BUILDING' || finalState === 'QUEUED') {
      return {
        success: true,
        message: 'Deployment in progress: https://' + deployment.url + ' (check Vercel dashboard)',
      };
    }

    if (finalState === 'ERROR') {
      return {
        success: false,
        error: 'Deployment failed. Check Vercel dashboard: https://vercel.com',
      };
    }

    return {
      success: false,
      error: 'Deployment status: ' + finalState,
    };
  } catch (e) {
    return {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Get deployment status from Vercel API
 */
export async function getDeploymentStatus(
  config: FactiiiConfig,
  deploymentId: string
): Promise<VercelDeployment | null> {
  const rootDir = process.cwd();

  try {
    const token = await getVercelToken(config, rootDir);
    const orgId = config.vercel?.org_id as string | undefined;

    const deployment = (await callVercelAPI('/v13/deployments/' + deploymentId, token, {
      teamId: orgId,
    })) as VercelDeployment;

    return deployment;
  } catch {
    return null;
  }
}

/**
 * List custom domains on a Vercel project
 */
export async function listProjectDomains(
  token: string,
  projectId: string,
  teamId?: string
): Promise<{ name: string; verified: boolean }[]> {
  try {
    const result = (await callVercelAPI('/v9/projects/' + projectId + '/domains', token, {
      teamId,
    })) as { domains?: { name: string; verified: boolean }[] };
    return result.domains ?? [];
  } catch {
    return [];
  }
}

/**
 * Add a custom domain to a Vercel project
 */
export async function addProjectDomain(
  token: string,
  projectId: string,
  domain: string,
  teamId?: string
): Promise<boolean> {
  try {
    await callVercelAPI('/v10/projects/' + projectId + '/domains', token, {
      method: 'POST',
      body: { name: domain },
      teamId,
    });
    return true;
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    // 409 = domain already exists (which is fine)
    if (errorMsg.includes('409')) return true;
    throw e;
  }
}
