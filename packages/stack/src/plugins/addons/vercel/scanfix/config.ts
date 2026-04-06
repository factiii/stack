/**
 * Vercel Configuration Scanfixes
 *
 * Detects and fixes Vercel project configuration issues.
 * Uses Vercel REST API exclusively (no CLI required).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Fix } from '../../../../types/index.js';
import type { FactiiiConfig } from '../../../../types/index.js';

/**
 * Auto-detect framework from package.json.
 * Used when creating Vercel projects so Vercel picks the right build settings.
 */
function detectFramework(rootDir: string): string | undefined {
  try {
    const pkgPath = path.join(rootDir, 'package.json');
    if (!fs.existsSync(pkgPath)) return undefined;
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if (deps['next']) return 'nextjs';
    if (deps['nuxt']) return 'nuxtjs';
    if (deps['gatsby']) return 'gatsby';
    if (deps['svelte'] || deps['@sveltejs/kit']) return 'sveltekit';
    if (deps['astro']) return 'astro';
    if (deps['remix'] || deps['@remix-run/react']) return 'remix';
    if (deps['vite']) return 'vite';
    if (deps['react']) return 'create-react-app';
    return undefined;
  } catch {
    return undefined;
  }
}

export const fixes: Fix[] = [
  {
    id: 'vercel-config-missing',
    stage: 'dev',
    severity: 'critical',
    description: 'Vercel configuration missing in stack.yml',
    scan: async (config: FactiiiConfig, _rootDir: string) => {
      // Skip if vercel not configured at all
      if (config.vercel === undefined) return false;

      // Check required fields
      const projectName = config.vercel.project_name as string | undefined;
      if (!projectName || projectName.toUpperCase().startsWith('EXAMPLE')) {
        return true;  // Problem: missing or example project name
      }

      return false;  // Configured properly
    },
    fix: async (config: FactiiiConfig, rootDir: string) => {
      console.log('   Auto-detecting Vercel project via API...');

      try {
        const { getVercelToken, findVercelProject, listVercelProjects, createVercelProject } =
          await import('../utils/vercel-api.js');

        // Get token
        let token: string;
        try {
          token = await getVercelToken(config, rootDir);
        } catch {
          console.log('   [!] VERCEL_TOKEN not found — cannot auto-detect project');
          console.log('   Run: npx stack fix --secrets  (to set VERCEL_TOKEN first)');
          return false;
        }

        const repoName = config.name ?? path.basename(rootDir);
        const teamId = config.vercel?.org_id as string | undefined;

        // Try to find existing project by repo name
        console.log('   Looking for project matching "' + repoName + '"...');
        let project = await findVercelProject(token, repoName, teamId);

        if (!project) {
          // List all projects so user can see what's available
          const allProjects = await listVercelProjects(token, teamId);

          if (allProjects.length > 0) {
            console.log('   No project named "' + repoName + '" found.');
            console.log('   Available projects:');
            for (const p of allProjects.slice(0, 10)) {
              console.log('     - ' + p.name + ' (id: ' + p.id + ')');
            }
            if (allProjects.length > 10) {
              console.log('     ... and ' + (allProjects.length - 10) + ' more');
            }
          }

          // Create the project automatically
          console.log('');
          console.log('   Creating Vercel project "' + repoName + '"...');

          const gitRepo = config.github_repo as string | undefined;
          const cleanGitRepo = gitRepo && !gitRepo.toUpperCase().startsWith('EXAMPLE')
            ? gitRepo
            : undefined;

          const framework = detectFramework(rootDir);
          if (framework) {
            console.log('   Detected framework: ' + framework);
          }

          try {
            project = await createVercelProject(token, repoName, {
              teamId,
              gitRepo: cleanGitRepo,
              framework,
            });
          } catch (createErr) {
            const createMsg = createErr instanceof Error ? createErr.message : String(createErr);
            // If GitHub App not installed, retry without git repo link
            if (createMsg.includes('GitHub') || createMsg.includes('400')) {
              console.log('   GitHub integration not installed — creating project without repo link');
              console.log('   (You can link it later in Vercel Dashboard → Project → Settings → Git)');
              project = await createVercelProject(token, repoName, {
                teamId,
                framework,
              });
            } else {
              throw createErr;
            }
          }

          console.log('   [OK] Created Vercel project: ' + project.name);
          // Auto-save team ID if it was discovered
          if (project.orgId && !teamId) {
            console.log('   [OK] Auto-detected team ID: ' + project.orgId);
          }
        } else {
          console.log('   [OK] Found existing project: ' + project.name);
        }

        // Update stack.yml with project info
        const { getStackConfigPath } = await import('../../../../constants/config-files.js');
        const configPath = getStackConfigPath(rootDir);
        let configContent = fs.readFileSync(configPath, 'utf8');

        // Check if there's an existing vercel section to update
        if (configContent.includes('vercel:')) {
          // Replace EXAMPLE values or add missing fields
          configContent = configContent
            .replace(/project_name:\s*EXAMPLE_[^\n]*/i, 'project_name: ' + project.name)
            .replace(/project_id:\s*EXAMPLE_[^\n]*/i, 'project_id: ' + project.id)
            .replace(/org_id:\s*EXAMPLE_[^\n]*/i, 'org_id: ' + (project.orgId ?? ''));

          // If project_id wasn't in the file, add it
          if (!configContent.includes('project_id:')) {
            configContent = configContent.replace(
              /project_name:\s*.+/,
              '$&\n  project_id: ' + project.id
            );
          }
        } else {
          // Add new vercel section
          const vercelSection = '\nvercel:\n' +
            '  project_name: ' + project.name + '\n' +
            '  project_id: ' + project.id + '\n' +
            (project.orgId ? '  org_id: ' + project.orgId + '\n' : '');
          configContent += vercelSection;
        }

        fs.writeFileSync(configPath, configContent, 'utf8');
        console.log('   [OK] Updated stack.yml with Vercel project config');

        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('403')) {
          // Token is team-scoped — auto-discover org_id
          console.log('   [!] 403 Forbidden — auto-discovering team ID...');
          try {
            const { getVercelToken, getVercelTeams, findVercelProject, createVercelProject } =
              await import('../utils/vercel-api.js');
            const token = await getVercelToken(config, rootDir);
            const teams = await getVercelTeams(token);

            if (teams.length === 0) {
              console.log('   [!] No teams found — token may need broader scope');
              console.log('   Create a new token: https://vercel.com/account/tokens');
              return false;
            }

            // Use the first team (most common for single-team setups)
            const team = teams[0]!;
            console.log('   [OK] Found team: ' + team.name + ' (id: ' + team.id + ')');

            // Save org_id to stack.yml
            const { getStackConfigPath } = await import('../../../../constants/config-files.js');
            const configPath = getStackConfigPath(rootDir);
            let configContent = fs.readFileSync(configPath, 'utf8');
            if (configContent.includes('vercel:') && !configContent.includes('org_id:')) {
              configContent = configContent.replace(/^(vercel:.*)/m, '$1\n  org_id: ' + team.id);
              fs.writeFileSync(configPath, configContent, 'utf8');
              console.log('   [OK] Saved org_id to stack.yml');
            }

            // Retry with team ID
            const repoName = config.name ?? path.basename(rootDir);
            let project = await findVercelProject(token, repoName, team.id);
            if (!project) {
              console.log('   Creating Vercel project "' + repoName + '"...');
              const framework = detectFramework(rootDir);
              project = await createVercelProject(token, repoName, { teamId: team.id, framework });
              console.log('   [OK] Created Vercel project: ' + project.name);
            } else {
              console.log('   [OK] Found existing project: ' + project.name);
            }

            // Update stack.yml with project info
            configContent = fs.readFileSync(configPath, 'utf8');
            configContent = configContent
              .replace(/project_name:\s*EXAMPLE_[^\n]*/i, 'project_name: ' + project.name)
              .replace(/project_id:\s*EXAMPLE_[^\n]*/i, 'project_id: ' + project.id);
            if (!configContent.includes('project_id:')) {
              configContent = configContent.replace(
                /project_name:\s*.+/,
                '$&\n  project_id: ' + project.id
              );
            }
            fs.writeFileSync(configPath, configContent, 'utf8');
            console.log('   [OK] Updated stack.yml with Vercel project config');
            return true;
          } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            console.log('   [!] Auto-discovery failed: ' + retryMsg);
            console.log('   Fix: Add org_id to vercel section in stack.yml:');
            console.log('     vercel:');
            console.log('       org_id: team_XXXXX  # from Vercel Settings → General');
            return false;
          }
        } else {
          console.log('   [!] Failed: ' + msg);
        }
        return false;
      }
    },
    manualFix: `
Add Vercel to stack.yml:

  vercel: {}

Then run: npx stack fix
(Auto-creates project, detects framework, and saves IDs via Vercel API)
    `,
  },

  {
    id: 'vercel-project-not-linked',
    stage: 'dev',
    severity: 'warning',
    description: 'Vercel project not linked (missing .vercel/project.json)',
    scan: async (config: FactiiiConfig, rootDir: string) => {
      // Skip if vercel not configured
      if (config.vercel === undefined) return false;

      // Skip if project_name is still EXAMPLE
      const projectName = config.vercel.project_name as string | undefined;
      if (!projectName || projectName.toUpperCase().startsWith('EXAMPLE')) {
        return false; // Will be caught by vercel-config-missing
      }

      // Check if .vercel/project.json exists
      const vercelConfigPath = path.join(rootDir, '.vercel', 'project.json');
      return !fs.existsSync(vercelConfigPath);
    },
    fix: async (config: FactiiiConfig, rootDir: string) => {
      console.log('   Auto-linking Vercel project via API...');

      try {
        const projectId = config.vercel?.project_id as string | undefined;
        const orgId = config.vercel?.org_id as string | undefined;
        const projectName = config.vercel?.project_name as string | undefined;

        if (!projectId && !projectName) {
          console.log('   [!] No project_id or project_name in stack.yml');
          return false;
        }

        let finalProjectId = projectId;
        let finalOrgId = orgId;

        // If we have name but no ID, look it up via API
        if (!finalProjectId && projectName) {
          const { getVercelToken, findVercelProject } =
            await import('../utils/vercel-api.js');

          const token = await getVercelToken(config, rootDir);
          const project = await findVercelProject(token, projectName, orgId);

          if (project) {
            finalProjectId = project.id;
            finalOrgId = finalOrgId ?? project.orgId;
            console.log('   Found project: ' + project.name + ' (id: ' + project.id + ')');
          } else {
            console.log('   [!] Project "' + projectName + '" not found in Vercel');
            return false;
          }
        }

        // Create .vercel directory
        const vercelDir = path.join(rootDir, '.vercel');
        if (!fs.existsSync(vercelDir)) {
          fs.mkdirSync(vercelDir, { recursive: true });
        }

        // Write project.json (same format as vercel link creates)
        const projectJson = {
          projectId: finalProjectId,
          orgId: finalOrgId ?? '',
        };
        fs.writeFileSync(
          path.join(vercelDir, 'project.json'),
          JSON.stringify(projectJson, null, 2) + '\n',
          'utf8'
        );

        console.log('   [OK] Created .vercel/project.json');
        console.log('   Project ID: ' + finalProjectId);
        if (finalOrgId) console.log('   Org ID: ' + finalOrgId);

        return true;
      } catch (e) {
        console.log('   [!] Failed: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: `
Run: npx stack fix
(Auto-creates .vercel/project.json from Vercel API — no CLI needed)
    `,
  },

  {
    id: 'vercel-gitignore-missing',
    stage: 'dev',
    severity: 'info',
    description: '.vercel directory not in .gitignore',
    scan: async (config: FactiiiConfig, rootDir: string) => {
      // Skip if vercel not configured
      if (config.vercel === undefined) return false;

      // Check if .vercel is in .gitignore
      const { isGitignored } = await import('../../../../utils/gitignore.js');
      const isIgnored = await isGitignored('.vercel', rootDir);

      return !isIgnored;  // Not ignored = problem
    },
    fix: async (_config: FactiiiConfig, rootDir: string) => {
      console.log('   Adding .vercel to .gitignore...');
      const { ensureGitignored } = await import('../../../../utils/gitignore.js');

      try {
        await ensureGitignored('.vercel', rootDir);
        console.log('   [OK] .vercel added to .gitignore');
        return true;
      } catch (e) {
        console.log('   [!] Failed to update .gitignore: ' + (e instanceof Error ? e.message : String(e)));
        return false;
      }
    },
    manualFix: 'Add .vercel to .gitignore manually: echo ".vercel" >> .gitignore',
  },
];
