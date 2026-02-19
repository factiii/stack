/**
 * Deployment Report Generator
 *
 * Generates formatted deployment readiness reports.
 */

interface RepoConfig {
  environments?: Record<string, { domain?: string; port?: number | string }>;
}

interface CurrentRepoInfo {
  deployed: boolean;
  config?: RepoConfig;
  comparison?: {
    hasChanges: boolean;
    changes: Array<{ field: string; old: string; new: string }>;
  };
}

interface DeployedRepo {
  name: string;
  domain: string;
  port?: number | string;
}

interface ServerCheck {
  environment: string;
  user?: string;
  host?: string;
  error?: string;
  connected?: boolean;
  infrastructureExists?: boolean;
  allDeployedRepos?: DeployedRepo[];
  currentRepo?: CurrentRepoInfo;
}

interface LocalChecks {
  coreYml?: boolean;
  dockerfile?: boolean;
  git?: boolean;
  branch?: string;
  workflows?: boolean;
  scripts?: boolean;
}

interface SecretsCheck {
  error?: string;
  present?: string[];
  missing?: string[];
}

interface Summary {
  ready: boolean;
  warnings: number;
  errors: number;
  nextSteps: string[];
}

interface ReportData {
  repoName: string;
  localChecks?: LocalChecks;
  secretsCheck?: SecretsCheck;
  serverChecks?: ServerCheck[];
  summary?: Summary;
}

interface AuditResults {
  coreYml: {
    exists: boolean;
    parseError?: boolean;
    needsCustomization?: boolean;
  };
  workflows: {
    allExist: boolean;
  };
  branches: {
    hasGit: boolean;
    currentBranch?: string;
  };
  repoScripts: {
    hasPackageJson: boolean;
    requiredScripts: Record<string, boolean>;
  };
}

/**
 * Format deployment readiness report
 */
export function formatDeploymentReport(data: ReportData): string {
  const { repoName, localChecks, secretsCheck, serverChecks, summary } = data;

  const lines: string[] = [];
  const separator = '━'.repeat(60);

  // Header
  lines.push(`DEPLOYMENT READINESS REPORT - ${repoName}`);
  lines.push(separator);
  lines.push('');

  // Local Configuration
  if (localChecks) {
    lines.push('LOCAL CONFIGURATION');
    if (localChecks.coreYml) {
      lines.push(`  [OK] stack.yml valid (${repoName})`);
    }
    if (localChecks.dockerfile) {
      lines.push('  [OK] Dockerfile found');
    }
    if (localChecks.git) {
      lines.push(
        `  [OK] Git configured${localChecks.branch ? ` (${localChecks.branch} branch)` : ''}`
      );
    }
    if (localChecks.workflows) {
      lines.push('  [OK] Workflows exist (factiii-deploy.yml, factiii-undeploy.yml)');
    }
    if (localChecks.scripts) {
      lines.push('  [OK] Required scripts present');
    }
    lines.push('');
  }

  // GitHub Secrets
  if (secretsCheck) {
    lines.push('GITHUB SECRETS');

    if (secretsCheck.error) {
      lines.push(`  [ERROR] ${secretsCheck.error}`);
      lines.push('   Cannot verify secrets via API');
    } else {
      // Show present secrets
      if (secretsCheck.present && secretsCheck.present.length > 0) {
        for (const secret of secretsCheck.present) {
          lines.push(`  [OK] ${secret} exists`);
        }
      }

      // Show missing secrets
      if (secretsCheck.missing && secretsCheck.missing.length > 0) {
        for (const secret of secretsCheck.missing) {
          lines.push(`  [!] ${secret} not found`);
        }
      }
    }
    lines.push('');
  }

  // Server Checks
  if (serverChecks && serverChecks.length > 0) {
    for (const server of serverChecks) {
      const envLabel = server.environment === 'staging' ? 'STAGING' : 'PRODUCTION';
      const envName = server.environment.toUpperCase();

      lines.push(`${envLabel} SERVER (${server.user}@${server.host})`);

      if (server.error) {
        lines.push(`  [ERROR] ${server.error}`);
      } else if (!server.connected) {
        lines.push('  [ERROR] SSH connection failed');
      } else {
        lines.push('  [OK] SSH connection successful');

        if (server.infrastructureExists) {
          lines.push('  [OK] Infrastructure directory exists');
        } else {
          lines.push('  [!] Infrastructure directory not found');
        }

        // Show currently deployed repos
        if (server.allDeployedRepos && server.allDeployedRepos.length > 0) {
          lines.push('');
          lines.push(`  Currently Deployed Repos (${server.allDeployedRepos.length}):`);
          for (const repo of server.allDeployedRepos) {
            const portInfo = repo.port ? `:${repo.port}` : '';
            lines.push(`    - ${repo.name} (${repo.domain}${portInfo}) - running`);
          }
        }

        // Show current repo status
        lines.push('');
        lines.push(`  THIS REPO (${repoName}):`);

        if (server.currentRepo && server.currentRepo.deployed) {
          const env = server.currentRepo.config?.environments?.[server.environment];
          if (env) {
            const currentPort = env.port ?? 'auto';
            lines.push(`      Current: ${env.domain}:${currentPort}`);

            // Show changes if any
            if (
              server.currentRepo.comparison &&
              server.currentRepo.comparison.hasChanges
            ) {
              lines.push(`      Changes detected:`);
              for (const change of server.currentRepo.comparison.changes) {
                lines.push(`       -> ${change.field}: ${change.old} -> ${change.new}`);
              }
            } else {
              lines.push(`      Status: No changes detected`);
            }
          }
        } else {
          lines.push('      Status: NOT DEPLOYED');
          lines.push('      After:  NEW deployment');
        }

        lines.push('');
        lines.push('  Note: Deploy will regenerate configs and restart ALL services');
      }

      lines.push('');
    }
  }

  // Summary
  lines.push(separator);

  if (summary) {
    const { ready, warnings, errors } = summary;

    if (ready && warnings === 0 && errors === 0) {
      lines.push('[OK] READY TO DEPLOY');
    } else if (errors > 0) {
      lines.push(
        `[ERROR] NOT READY (${errors} error${errors > 1 ? 's' : ''}, ${warnings} warning${warnings > 1 ? 's' : ''})`
      );
    } else if (warnings > 0) {
      lines.push(`[!] READY TO DEPLOY (${warnings} warning${warnings > 1 ? 's' : ''})`);
    }
  }

  lines.push('');

  // Next Steps
  if (summary && summary.nextSteps && summary.nextSteps.length > 0) {
    lines.push('Next Steps:');
    for (let i = 0; i < summary.nextSteps.length; i++) {
      lines.push(`   ${i + 1}. ${summary.nextSteps[i]}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format report for GitHub workflow summary (supports markdown)
 */
export function formatWorkflowSummary(data: ReportData): string {
  const report = formatDeploymentReport(data);

  // Workflow summaries support markdown, so we can enhance it
  return `\`\`\`
${report}
\`\`\``;
}

/**
 * Generate summary statistics from check results
 */
export function generateSummary(
  _localChecks: LocalChecks | undefined,
  secretsCheck: SecretsCheck | undefined,
  serverChecks: ServerCheck[] | undefined
): Summary {
  const summary: Summary = {
    ready: true,
    warnings: 0,
    errors: 0,
    nextSteps: [],
  };

  // Check for missing secrets
  if (secretsCheck) {
    if (secretsCheck.error) {
      summary.errors++;
      summary.ready = false;
      summary.nextSteps.push('Fix GitHub token permissions to verify secrets');
    } else if (secretsCheck.missing && secretsCheck.missing.length > 0) {
      summary.warnings += secretsCheck.missing.length;
      for (const secret of secretsCheck.missing) {
        summary.nextSteps.push(`Add missing GitHub secret: ${secret}`);
      }
    }
  }

  // Check server connection issues
  if (serverChecks) {
    for (const server of serverChecks) {
      if (server.error || !server.connected) {
        summary.errors++;
        summary.ready = false;
        summary.nextSteps.push(`Fix SSH connection to ${server.environment} server`);
      }
    }
  }

  // If ready, add deployment instructions
  if (summary.ready && summary.warnings === 0) {
    summary.nextSteps.push('Run: npx factiii deploy --environment staging');
    summary.nextSteps.push('Or push to main branch to trigger automatic deployment');
  } else if (summary.ready && summary.warnings > 0) {
    summary.nextSteps.push('Review warnings above');
    summary.nextSteps.push('Run: npx factiii deploy (deployment will proceed with warnings)');
  } else {
    summary.nextSteps.push('Fix errors above');
    summary.nextSteps.push('Run: npx factiii (to verify fixes)');
  }

  return summary;
}

/**
 * Format local check results
 */
export function formatLocalChecks(auditResults: AuditResults): LocalChecks {
  const { coreYml, workflows, branches, repoScripts } = auditResults;

  return {
    coreYml: coreYml.exists && !coreYml.parseError && !coreYml.needsCustomization,
    dockerfile: true, // Checked separately in scan
    git: branches.hasGit,
    branch: branches.currentBranch,
    workflows: workflows.allExist,
    scripts:
      repoScripts.hasPackageJson &&
      Object.values(repoScripts.requiredScripts).every((v) => v),
  };
}

