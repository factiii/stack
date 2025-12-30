/**
 * Staging environment operations for Mac Mini plugin
 * Handles staging deployment, server preparation, and staging-specific helpers
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';

import { sshExec } from '../../../utils/ssh-helper.js';
import { extractEnvironments } from '../../../utils/config-helpers.js';
import type {
  FactiiiConfig,
  EnvironmentConfig,
  DeployResult,
  EnsureServerReadyOptions,
} from '../../../types/index.js';


/**
 * Execute a command on a remote server via SSH
 */
async function sshExecCommand(envConfig: EnvironmentConfig, command: string): Promise<string> {
  return await sshExec(envConfig, command);
}

/**
 * Ensure Node.js is installed on the server
 */
async function ensureNodeInstalled(envConfig: EnvironmentConfig): Promise<void> {
  try {
    await sshExecCommand(envConfig, 'which node');
  } catch {
    console.log('      Installing Node.js...');
    await sshExecCommand(
      envConfig,
      'brew install node || (curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs)'
    );
  }
}

/**
 * Ensure git is installed on the server
 */
async function ensureGitInstalled(envConfig: EnvironmentConfig): Promise<void> {
  try {
    await sshExecCommand(envConfig, 'which git');
  } catch {
    console.log('      Installing git...');
    await sshExecCommand(envConfig, 'brew install git || sudo apt-get install -y git');
  }
}

/**
 * Ensure pnpm is installed on the server
 */
async function ensurePnpmInstalled(envConfig: EnvironmentConfig): Promise<void> {
  try {
    await sshExecCommand(envConfig, 'which pnpm');
  } catch {
    console.log('      Installing pnpm...');
    await sshExecCommand(envConfig, 'npm install -g pnpm@9');
  }
}

/**
 * Ensure repository is cloned
 */
async function ensureRepoCloned(
  envConfig: EnvironmentConfig,
  repoUrl: string | undefined,
  repoDir: string,
  repoName: string
): Promise<void> {
  const checkExists = await sshExecCommand(
    envConfig,
    `test -d ${repoDir}/.git && echo "exists" || echo "missing"`
  );

  if (checkExists.includes('missing')) {
    console.log('      Cloning repository...');

    // Extract GitHub repo from URL if provided, otherwise use GITHUB_REPO env var
    let gitUrl = repoUrl;
    if (repoUrl && !repoUrl.startsWith('git@') && !repoUrl.startsWith('https://')) {
      // Format: owner/repo
      gitUrl = `git@github.com:${repoUrl}.git`;
    }

    await sshExecCommand(
      envConfig,
      `mkdir -p ~/.factiii && cd ~/.factiii && git clone ${gitUrl} ${repoName}`
    );
  }
}

/**
 * Pull latest changes and checkout specific commit
 */
async function pullAndCheckout(
  envConfig: EnvironmentConfig,
  repoDir: string,
  branch: string,
  commitHash: string | undefined
): Promise<void> {
  console.log(
    `      Checking out ${branch}${commitHash ? ' @ ' + commitHash.substring(0, 7) : ''}...`
  );

  const commands = [
    `cd ${repoDir}`,
    'git fetch --all',
    `git checkout ${branch}`,
    `git pull origin ${branch}`,
  ];

  // If commit hash provided, checkout that specific commit
  if (commitHash) {
    commands.push(`git checkout ${commitHash}`);
  }

  await sshExecCommand(envConfig, commands.join(' && '));
}

/**
 * Install dependencies using pnpm
 */
async function installDependencies(
  envConfig: EnvironmentConfig,
  repoDir: string
): Promise<void> {
  await sshExecCommand(envConfig, `cd ${repoDir} && pnpm install`);
}

/**
 * Write environment variables to .env file on server
 * Handles both local (on-server) and remote (SSH) execution
 */
async function writeEnvFile(
  envConfig: EnvironmentConfig,
  repoDir: string,
  environment: string,
  envVarsString: string | undefined
): Promise<void> {
  if (!envVarsString) {
    // If no env vars provided, skip writing (allow manual .env files)
    return;
  }

  const envFileName = `.env.${environment === 'production' ? 'prod' : environment}`;
  const isOnServer = process.env.GITHUB_ACTIONS === 'true';

  // Parse env vars string (newline-separated KEY=VALUE format)
  const envVars = envVarsString
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .filter((line) => line.includes('='));

  if (envVars.length === 0) {
    console.log(`   ⚠️  No environment variables found in ${environment} secrets`);
    return;
  }

  // Build env file content
  const envFileContent = envVars.join('\n') + '\n';

  if (isOnServer) {
    // We're on the server - write directly
    const expandedRepoDir = repoDir.replace('~', process.env.HOME ?? '/Users/jon');
    const envFilePath = path.join(expandedRepoDir, envFileName);
    
    console.log(`   📝 Writing ${envFileName} (${envVars.length} variables)...`);
    fs.writeFileSync(envFilePath, envFileContent, 'utf8');
  } else {
    // We're remote - SSH to write
    console.log(`   📝 Writing ${envFileName} on remote server (${envVars.length} variables)...`);
    
    // Escape the content for shell
    const escapedContent = envFileContent
      .replace(/'/g, "'\\''")
      .replace(/\n/g, '\\n');
    
    await sshExecCommand(
      envConfig,
      `cat > ${repoDir}/${envFileName} << 'ENVEOF'
${envFileContent}ENVEOF`
    );
  }
}

/**
 * Create .env file from .env.staging for host commands
 * Replaces postgres:5432 with localhost:5438 so host commands can connect
 * Handles both local (on-server) and remote (SSH) execution
 */
async function createEnvFromStaging(
  envConfig: EnvironmentConfig,
  repoDir: string
): Promise<void> {
  const isOnServer = process.env.GITHUB_ACTIONS === 'true';
  const stagingEnvPath = isOnServer
    ? path.join(repoDir.replace('~', process.env.HOME ?? '/Users/jon'), '.env.staging')
    : `${repoDir}/.env.staging`;
  const envPath = isOnServer
    ? path.join(repoDir.replace('~', process.env.HOME ?? '/Users/jon'), '.env')
    : `${repoDir}/.env`;

  // Read .env.staging
  let envContent: string;
  if (isOnServer) {
    if (!fs.existsSync(stagingEnvPath)) {
      // .env.staging might not exist yet, skip gracefully
      return;
    }
    envContent = fs.readFileSync(stagingEnvPath, 'utf8');
  } else {
    // Remote - read via SSH
    try {
      envContent = await sshExecCommand(envConfig, `cat ${stagingEnvPath}`);
    } catch {
      // .env.staging might not exist yet, skip gracefully
      return;
    }
  }

  // Replace postgres:5432 with localhost:5438 in DATABASE_URL and TEST_DATABASE_URL
  // This allows host commands to connect via the exposed port
  const updatedContent = envContent
    .split('\n')
    .map((line) => {
      // Match DATABASE_URL or TEST_DATABASE_URL lines
      if (line.match(/^(DATABASE_URL|TEST_DATABASE_URL)=/)) {
        // Replace postgres:5432 with localhost:5438
        // Handle both postgresql:// and postgres:// protocols
        return line.replace(/@postgres:5432\//g, '@localhost:5438/');
      }
      return line;
    })
    .join('\n');

  // Write to .env file
  if (isOnServer) {
    fs.writeFileSync(envPath, updatedContent, 'utf8');
    console.log('   📝 Created .env from .env.staging (with host port replacement)');
  } else {
    await sshExecCommand(
      envConfig,
      `cat > ${envPath} << 'ENVEOF'
${updatedContent}ENVEOF`
    );
    console.log('   📝 Created .env from .env.staging on remote server (with host port replacement)');
  }
}


/**
 * Ensure server is ready for deployment
 * Installs Node.js, git, pnpm, clones repo, checks out commit
 */
export async function ensureServerReady(
  config: FactiiiConfig,
  environment: string,
  options: EnsureServerReadyOptions = {}
): Promise<DeployResult> {
  // Mac Mini only handles staging-type environments (staging, staging2, etc.)
  if (!environment.startsWith('staging') && !environment.startsWith('stage-')) {
    return { success: true, message: 'Mac Mini only handles staging environments' };
  }

  // Get environment config (supports both v1.x and v2.0.0+ formats)
  const environments = extractEnvironments(config);
  const envConfig = environments[environment];

  if (!envConfig?.host) {
    throw new Error(`${environment} host not configured`);
  }

  const { commitHash, branch = 'main', repoUrl } = options;
  const repoName = config.name ?? 'app';
  const repoDir = `~/.factiii/${repoName}`;

  try {
    // 1. Ensure Node.js is installed
    console.log('   Checking Node.js...');
    await ensureNodeInstalled(envConfig);

    // 2. Ensure git is installed
    console.log('   Checking git...');
    await ensureGitInstalled(envConfig);

    // 3. Ensure repo is cloned and up to date
    console.log('   Syncing repository...');
    await ensureRepoCloned(envConfig, repoUrl, repoDir, repoName);
    await pullAndCheckout(envConfig, repoDir, branch, commitHash);

    // 4. Ensure pnpm is installed
    console.log('   Checking pnpm...');
    await ensurePnpmInstalled(envConfig);

    // 5. Install dependencies
    console.log('   Installing dependencies...');
    await installDependencies(envConfig, repoDir);

    // 6. Write environment variables from GitHub secrets if provided
    const envVarsString = process.env.STAGING_ENVS;
    if (envVarsString) {
      console.log('   Writing environment variables...');
      await writeEnvFile(envConfig, repoDir, 'staging', envVarsString);
    } else {
      console.log('   ⚠️  STAGING_ENVS not provided, skipping env file write (using existing .env.staging if present)');
    }

    // 7. Create .env from .env.staging for host commands
    console.log('   Creating .env from .env.staging for host commands...');
    await createEnvFromStaging(envConfig, repoDir);

    return { success: true, message: 'Server ready' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare server: ${errorMessage}`);
  }
}

/**
 * Parse DATABASE_URL to extract connection details
 * Format: postgresql://user:password@host:port/database
 */
function parseDatabaseUrl(databaseUrl: string): {
  user: string;
  password: string;
  host: string;
  port: number;
  database: string;
} | null {
  try {
    const url = new URL(databaseUrl);
    return {
      user: url.username || 'postgres',
      password: url.password || 'password',
      host: url.hostname || 'localhost',
      port: parseInt(url.port || '5432', 10),
      database: url.pathname.slice(1) || 'postgres', // Remove leading /
    };
  } catch {
    return null;
  }
}

/**
 * Add postgres service to docker-compose.yml for staging
 * Reads DATABASE_URL from .env.staging to configure the postgres service
 * Only applies to staging - production uses RDS
 */
async function addPostgresServiceForStaging(
  envConfig: EnvironmentConfig,
  config: FactiiiConfig
): Promise<void> {
  const repoName = config.name ?? 'app';
  const repoDir = `~/.factiii/${repoName}`;
  const isOnServer = process.env.GITHUB_ACTIONS === 'true';

  // Read .env.staging to get DATABASE_URL
  let databaseUrl: string | null = null;
  if (isOnServer) {
    const expandedRepoDir = repoDir.replace('~', process.env.HOME ?? '/Users/jon');
    const envFilePath = path.join(expandedRepoDir, '.env.staging');
    if (fs.existsSync(envFilePath)) {
      const envContent = fs.readFileSync(envFilePath, 'utf8');
      const match = envContent.match(/^DATABASE_URL=(.+)$/m);
      if (match) {
        databaseUrl = match[1]?.trim() || null;
      }
    }
  } else {
    // Remote - read via SSH
    try {
      const envContent = await sshExecCommand(envConfig, `cat ${repoDir}/.env.staging`);
      const match = envContent.match(/^DATABASE_URL=(.+)$/m);
      if (match) {
        databaseUrl = match[1]?.trim() || null;
      }
    } catch {
      // .env.staging might not exist yet
    }
  }

  if (!databaseUrl) {
    console.log('   ⚠️  DATABASE_URL not found in .env.staging, skipping postgres service');
    return;
  }

  const dbConfig = parseDatabaseUrl(databaseUrl);
  if (!dbConfig) {
    console.log('   ⚠️  Could not parse DATABASE_URL, skipping postgres service');
    return;
  }

  const factiiiDir = isOnServer
    ? path.join(process.env.HOME ?? '/Users/jon', '.factiii')
    : '~/.factiii';
  const composePath = isOnServer
    ? path.join(factiiiDir, 'docker-compose.yml')
    : '~/.factiii/docker-compose.yml';

  // Read docker-compose.yml
  let composeContent: string;
  if (isOnServer) {
    if (!fs.existsSync(composePath)) {
      console.log('   ⚠️  docker-compose.yml not found, skipping postgres service');
      return;
    }
    composeContent = fs.readFileSync(composePath, 'utf8');
  } else {
    composeContent = await sshExecCommand(envConfig, `cat ${composePath}`);
  }

  const compose = yaml.load(composeContent) as {
    services?: Record<string, unknown>;
    volumes?: Record<string, unknown>;
    [key: string]: unknown;
  };

  // Check if postgres service already exists
  if (compose.services && 'postgres' in compose.services) {
    console.log('   ℹ️  Postgres service already exists in docker-compose.yml');
    return;
  }

  // Add postgres service
  if (!compose.services) {
    compose.services = {};
  }

  compose.services.postgres = {
    image: 'postgres:16-alpine',
    container_name: 'factiii_postgres',
    restart: 'unless-stopped',
    environment: {
      POSTGRES_USER: dbConfig.user,
      POSTGRES_PASSWORD: dbConfig.password,
      POSTGRES_DB: dbConfig.database,
    },
    ports: [`${dbConfig.port}:5432`],
    volumes: ['postgres_data:/var/lib/postgresql/data'],
    networks: ['factiii'],
  };

  // Add volumes section if it doesn't exist
  if (!compose.volumes) {
    compose.volumes = {};
  }
  (compose.volumes as Record<string, unknown>).postgres_data = {};

  // Write back
  const updatedContent = yaml.dump(compose, { lineWidth: -1 });
  if (isOnServer) {
    fs.writeFileSync(composePath, updatedContent);
  } else {
    await sshExecCommand(
      envConfig,
      `cat > ${composePath} << 'EOF'\n${updatedContent}\nEOF`
    );
  }

  console.log(`   ✅ Added postgres service (port ${dbConfig.port}, database: ${dbConfig.database})`);
}

/**
 * Update docker-compose.yml to replace build context with staging image tag
 * This is called after buildStagingImage() completes to ensure docker-compose uses the pre-built image
 */
async function updateComposeForStagingImage(
  envConfig: EnvironmentConfig,
  config: FactiiiConfig
): Promise<void> {
  const repoName = config.name ?? 'app';
  const serviceName = `${repoName}-staging`;
  const imageTag = `${repoName}:staging`;

  const isOnServer = process.env.GITHUB_ACTIONS === 'true';

  if (isOnServer) {
    // We're on the server - read and update directly
    const factiiiDir = path.join(process.env.HOME ?? '/Users/jon', '.factiii');
    const composePath = path.join(factiiiDir, 'docker-compose.yml');

    if (!fs.existsSync(composePath)) {
      console.log('   ⚠️  docker-compose.yml not found, skipping update');
      return;
    }

    const composeContent = fs.readFileSync(composePath, 'utf8');
    const compose = yaml.load(composeContent) as {
      services?: Record<
        string,
        {
          build?: { context?: string; dockerfile?: string };
          image?: string;
          [key: string]: unknown;
        }
      >;
      [key: string]: unknown;
    };

    if (compose.services && compose.services[serviceName]) {
      // Remove build section and set image to staging tag
      delete compose.services[serviceName].build;
      compose.services[serviceName].image = imageTag;
    }

    // Write back
    const updatedContent = yaml.dump(compose, { lineWidth: -1 });
    fs.writeFileSync(composePath, updatedContent);
  } else {
    // We're remote - SSH to update
    const composeContent = await sshExecCommand(
      envConfig,
      'cat ~/.factiii/docker-compose.yml'
    );

    // Parse and update
    const compose = yaml.load(composeContent) as {
      services?: Record<
        string,
        {
          build?: { context?: string; dockerfile?: string };
          image?: string;
          [key: string]: unknown;
        }
      >;
      [key: string]: unknown;
    };

    if (compose.services && compose.services[serviceName]) {
      // Remove build section and set image to staging tag
      delete compose.services[serviceName].build;
      compose.services[serviceName].image = imageTag;
    }

    // Write back to server
    const updatedContent = yaml.dump(compose, { lineWidth: -1 });
    await sshExecCommand(
      envConfig,
      `cat > ~/.factiii/docker-compose.yml << 'EOF'\n${updatedContent}\nEOF`
    );
  }
}

/**
 * Deploy to staging environment
 *
 * Note: Docker image building is handled by the pipeline plugin (staging.ts)
 * This method only handles deployment (regenerating docker-compose.yml and starting containers)
 *
 * @param config - Factiii config (supports both v1.x and v2.0.0+)
 * @param environment - Environment name (defaults to 'staging' for backward compatibility)
 */
export async function deployStaging(
  config: FactiiiConfig,
  environment: string = 'staging'
): Promise<DeployResult> {
  // Get environment config (supports both v1.x and v2.0.0+ formats)
  const environments = extractEnvironments(config);
  const envConfig = environments[environment];

  if (!envConfig?.host) {
    return { success: false, error: `${environment} host not configured` };
  }

  console.log(`   🚀 Deploying on staging (${envConfig.host})...`);

  try {
    const repoName = config.name ?? 'app';
    const repoDir = `~/.factiii/${repoName}`;

    // Determine if we're running ON the server or remotely
    // When GITHUB_ACTIONS=true, we're executing on the server itself
    const isOnServer = process.env.GITHUB_ACTIONS === 'true';

    console.log(`   📍 Deployment mode: ${isOnServer ? 'on-server' : 'remote'}`);

    if (isOnServer) {
      // We're on the server - run commands directly
      const factiiiDir = path.join(process.env.HOME ?? '/Users/jon', '.factiii');

      // Step 1: Regenerate unified docker-compose.yml
      console.log('   🔄 Regenerating unified docker-compose.yml...');
      const generateAllPath = path.join(factiiiDir, 'scripts', 'generate-all.js');
      if (fs.existsSync(generateAllPath)) {
        execSync(`node ${generateAllPath}`, {
          stdio: 'inherit',
          shell: '/bin/bash',
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
          },
        });
      } else {
        console.log('   ⚠️  generate-all.js not found, skipping regeneration');
      }

      // Step 1.5: Add postgres service for staging if DATABASE_URL is configured
      console.log('   🔄 Adding postgres service for staging...');
      await addPostgresServiceForStaging(envConfig, config);

      // Step 2: Update docker-compose.yml to use pre-built staging image
      console.log('   🔄 Updating docker-compose.yml with staging image tag...');
      await updateComposeForStagingImage(envConfig, config);

      // Step 3: Deploy using unified docker-compose.yml
      const unifiedCompose = path.join(factiiiDir, 'docker-compose.yml');
      if (!fs.existsSync(unifiedCompose)) {
        return {
          success: false,
          error: 'Unified docker-compose.yml not found. Run generate-all.js first.',
        };
      }

      console.log('   🚀 Starting containers with unified docker-compose.yml...');
      execSync(
        `cd ${factiiiDir} && docker compose up -d`,
        {
          stdio: 'inherit',
          shell: '/bin/bash',
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
          },
        }
      );
    } else {
      // We're remote - SSH to the server
      // Step 1: Regenerate unified docker-compose.yml
      console.log('   🔄 Regenerating unified docker-compose.yml on remote server...');
      await sshExecCommand(
        envConfig,
        `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && \
         if [ -f ~/.factiii/scripts/generate-all.js ]; then \
           node ~/.factiii/scripts/generate-all.js; \
         else \
           echo "⚠️  generate-all.js not found, skipping regeneration"; \
         fi`
      );

      // Step 1.5: Add postgres service for staging if DATABASE_URL is configured
      console.log('   🔄 Adding postgres service for staging...');
      await addPostgresServiceForStaging(envConfig, config);

      // Step 2: Update docker-compose.yml to use pre-built staging image
      console.log('   🔄 Updating docker-compose.yml with staging image tag...');
      await updateComposeForStagingImage(envConfig, config);

      // Step 3: Deploy using unified docker-compose.yml
      console.log('   🚀 Starting containers with unified docker-compose.yml on remote server...');
      await sshExecCommand(
        envConfig,
        `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && \
         if [ ! -f ~/.factiii/docker-compose.yml ]; then \
           echo "❌ Unified docker-compose.yml not found. Run generate-all.js first." && \
           exit 1; \
         fi && \
         cd ~/.factiii && \
         docker compose up -d`
      );
    }

    return { success: true, message: 'Staging deployment complete' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`   ❌ Deployment failed: ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

