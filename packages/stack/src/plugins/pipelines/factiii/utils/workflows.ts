/**
 * Workflow Generation and Triggering Utilities
 * 
 * Static methods for managing GitHub Actions workflows:
 * - Generate workflow files from templates
 * - Trigger workflows via GitHub API
 */

import * as fs from 'fs';
import * as path from 'path';
import { getFactiiiVersion } from '../../../../utils/version-check.js';

/**
 * Generate GitHub workflow files in the target repository
 */
export async function generateWorkflows(rootDir: string): Promise<void> {
  const workflowsDir = path.join(rootDir, '.github', 'workflows');
  const sourceDir = path.join(__dirname, '../workflows');

  // Get package version
  const version = getFactiiiVersion();

  // Create .github/workflows if it doesn't exist
  if (!fs.existsSync(workflowsDir)) {
    fs.mkdirSync(workflowsDir, { recursive: true });
  }

  // CI workflows (testing only - no SSH, no deployment):
  //   - stack-ci.yml: Build + test on push/PR to main
  //   - stack-cicd-prod.yml: Build + test on push to prod
  // Deployment is handled via SSH from dev machine, not workflows.
  const workflows = [
    'stack-ci.yml',
    'stack-cicd-prod.yml',
  ];

  for (const workflow of workflows) {
    const sourcePath = path.join(sourceDir, workflow);
    const destPath = path.join(workflowsDir, workflow);

    if (fs.existsSync(sourcePath)) {
      let content = fs.readFileSync(sourcePath, 'utf8');

      // Replace version placeholder with actual version
      content = content.replace(/v\{VERSION\}/g, `v${version}`);

      fs.writeFileSync(destPath, content);
      console.log(`   ✅ Generated ${workflow}`);
    }
  }
}

