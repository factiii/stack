/**
 * Staging environment operations for macOS plugin
 * Handles staging deployment, server preparation, and staging-specific helpers
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';

import { sshExec } from '../../../utils/ssh-helper.js';
import { extractEnvironments } from '../../../utils/config-helpers.js';
import { generateDockerCompose, generateNginx, scanRepos, loadConfigs } from '../../../scripts/index.js';
import { reportCommitStatus } from '../../../utils/github-status.js';
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

// ============================================================
// CRITICAL: SSL Certificate Management
// ============================================================
// Why this exists: Automatically obtain/renew Let's Encrypt SSL certificates
// What breaks if changed: HTTPS will fail, browsers show security warnings
// Dependencies: Docker must be installed, ssl_email must be configured
// Uses Docker certbot for portability (no host certbot installation needed)
// ============================================================

/**
 * Run certbot to obtain/renew SSL certificates using Docker
 * Called after nginx.conf is generated but before containers start
 * Collects all domains from all environments in factiii.yml and obtains certificates
 * Uses standalone mode with Docker certbot (nginx must be stopped first)
 */
async function runCertbot(
  envConfig: EnvironmentConfig,
  config: FactiiiConfig
): Promise<void> {
  const environments = extractEnvironments(config);

  // Collect all domains that need certificates
  const domains: string[] = [];
  for (const env of Object.values(environments)) {
    if (env.domain && !env.domain.startsWith('EXAMPLE-')) {
      domains.push(env.domain);
    }
  }

  if (domains.length === 0) {
    console.log('      No domains configured, skipping SSL certificates');
    return;
  }

  const sslEmail = config.ssl_email;
  if (!sslEmail || sslEmail.startsWith('EXAMPLE-')) {
    console.log('      ⚠️  ssl_email not configured in factiii.yml, skipping SSL');
    console.log('      Add ssl_email to factiii.yml to enable automatic SSL certificates');
    return;
  }

  const isOnServer = process.env.GITHUB_ACTIONS === 'true';

  // For each domain, obtain certificate using Docker certbot
  for (const domain of domains) {
    console.log(`      Obtaining SSL certificate for: ${domain}`);

    // Build Docker certbot command (standalone mode - port 80 must be free)
    const certbotCmd = [
      'docker run --rm',
      '-v /etc/letsencrypt:/etc/letsencrypt',
      '-v /var/lib/letsencrypt:/var/lib/letsencrypt',
      '-p 80:80',
      'certbot/certbot certonly',
      '--standalone',
      '-d ' + domain,
      '--email ' + sslEmail,
      '--agree-tos',
      '--non-interactive',
    ].join(' ');

    try {
      if (isOnServer) {
        // We're on the server - run directly
        execSync(certbotCmd, {
          stdio: 'inherit',
          shell: '/bin/bash',
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
          },
        });
      } else {
        // We're remote - SSH to server
        await sshExecCommand(
          envConfig,
          `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && ${certbotCmd}`
        );
      }
      console.log(`      ✅ SSL certificate obtained for ${domain}`);
    } catch (error) {
      console.log(`      ⚠️  Certbot failed for ${domain}, continuing without SSL`);
    }
  }
}

/**
 * Setup automatic certificate renewal via cron using Docker certbot
 * Only runs once - checks if renewal is already configured
 */
async function setupCertbotRenewal(envConfig: EnvironmentConfig): Promise<void> {
  console.log('      Setting up automatic certificate renewal...');

  const isOnServer = process.env.GITHUB_ACTIONS === 'true';

  // Docker certbot renewal command (webroot mode since nginx will be running)
  const renewCmd = 'docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v /var/lib/letsencrypt:/var/lib/letsencrypt -v /var/www/certbot:/var/www/certbot certbot/certbot renew --quiet && docker exec factiii_nginx nginx -s reload';

  if (isOnServer) {
    // Check if certbot renewal is already configured
    try {
      const result = execSync('crontab -l 2>/dev/null | grep "certbot/certbot renew" || echo "NOT_FOUND"', {
        encoding: 'utf-8',
        shell: '/bin/bash',
      });

      if (result.includes('NOT_FOUND')) {
        // Add renewal cron job (runs twice daily)
        execSync(
          `(crontab -l 2>/dev/null; echo "0 0,12 * * * ${renewCmd}") | crontab -`,
          { stdio: 'inherit', shell: '/bin/bash' }
        );
        console.log('      ✅ Configured automatic certificate renewal (twice daily)');
      } else {
        console.log('      ✅ Certificate renewal already configured');
      }
    } catch {
      console.log('      ⚠️  Could not configure certificate renewal');
    }
  } else {
    // Check if certbot renewal is already configured
    const cronCheck = await sshExecCommand(
      envConfig,
      'crontab -l 2>/dev/null | grep "certbot/certbot renew" || echo "NOT_FOUND"'
    );

    if (cronCheck.includes('NOT_FOUND')) {
      // Add renewal cron job (runs twice daily)
      await sshExecCommand(
        envConfig,
        `(crontab -l 2>/dev/null; echo "0 0,12 * * * ${renewCmd}") | crontab -`
      );
      console.log('      ✅ Configured automatic certificate renewal (twice daily)');
    } else {
      console.log('      ✅ Certificate renewal already configured');
    }
  }
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
  // macOS server only handles staging-type environments (staging, staging2, etc.)
  if (!environment.startsWith('staging') && !environment.startsWith('stage-')) {
    return { success: true, message: 'macOS server only handles staging environments' };
  }

  // Get environment config (supports both v1.x and v2.0.0+ formats)
  const environments = extractEnvironments(config);
  const envConfig = environments[environment];

  if (!envConfig?.domain) {
    throw new Error(`${environment} domain not configured`);
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

// ============================================================
// MIGRATION / BACKUP / ROLLBACK HELPERS
// ============================================================
// Reusable for staging and production deploy flows.
// These run LOCALLY on whatever machine they're called on.
// ============================================================

const DEPLOY_PATH_PREFIX = '/opt/homebrew/bin:/usr/local/bin:';

/**
 * Get DATABASE_URL from the stage-specific .env file
 */
function getDatabaseUrl(repoDir: string, stage: string): string | null {
  const envFile = stage === 'dev' ? '.env' : '.env.' + stage;
  const envPath = path.join(repoDir, envFile);

  if (!fs.existsSync(envPath)) return process.env.DATABASE_URL ?? null;

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('DATABASE_URL=')) {
        return trimmed.slice('DATABASE_URL='.length).replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // Ignore
  }

  return process.env.DATABASE_URL ?? null;
}

/**
 * Check if there are pending Prisma migrations
 * Returns true if there ARE pending migrations that need to run
 */
function checkPendingMigrations(repoDir: string, pathEnv: string): boolean {
  try {
    const output = execSync(
      'npx prisma migrate status',
      {
        cwd: repoDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: '/bin/bash',
        env: { ...process.env, PATH: pathEnv },
      }
    );
    // Prisma outputs "Following migration(s) have not yet been applied:" when pending
    // Or "Database schema is up to date!" when no pending migrations
    if (output.includes('have not yet been applied') || output.includes('not yet been applied')) {
      return true;
    }
    return false;
  } catch (error) {
    // migrate status exits with non-zero if there are pending migrations or issues
    const errOutput = error instanceof Error ? (error as { stderr?: string }).stderr ?? '' : '';
    if (typeof errOutput === 'string' && (errOutput.includes('have not yet been applied') || errOutput.includes('not yet been applied'))) {
      return true;
    }
    // If we can't determine, assume there might be migrations (safer)
    console.log('   ⚠️  Could not check migration status, will attempt migrate deploy');
    return true;
  }
}

/**
 * Create a .tar.gz database backup using pg_dump
 * Returns the backup file path or null on failure
 */
function backupDatabase(dbUrl: string, stage: string, backupDir: string): string | null {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, 'backup-' + stage + '-' + timestamp + '.tar.gz');

  try {
    // Ensure backup dir exists
    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    console.log('   💾 Creating database backup: ' + backupPath);
    execSync(
      'pg_dump -Ft "' + dbUrl + '" > "' + backupPath + '"',
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: '/bin/bash',
        env: {
          ...process.env,
          PATH: DEPLOY_PATH_PREFIX + (process.env.PATH ?? ''),
        },
      }
    );

    // Verify the backup file was created and has content
    if (fs.existsSync(backupPath) && fs.statSync(backupPath).size > 0) {
      console.log('   ✅ Database backup created');
      return backupPath;
    }

    console.log('   ⚠️  Backup file is empty or missing');
    return null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log('   ❌ Database backup failed: ' + msg);
    return null;
  }
}

/**
 * Restore database from a .tar.gz backup
 * Returns true on success
 */
function restoreDatabase(dbUrl: string, backupPath: string): boolean {
  try {
    console.log('   🔄 Restoring database from backup: ' + backupPath);
    execSync(
      'pg_restore --clean --if-exists -d "' + dbUrl + '" "' + backupPath + '"',
      {
        stdio: 'inherit',
        shell: '/bin/bash',
        env: {
          ...process.env,
          PATH: DEPLOY_PATH_PREFIX + (process.env.PATH ?? ''),
        },
      }
    );
    console.log('   ✅ Database restored from backup');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log('   ❌ Database restore failed: ' + msg);
    return false;
  }
}

/**
 * Health check containers after deploy
 * Waits a few seconds then checks if containers are running
 * Returns true if containers are healthy
 */
function healthCheckContainers(containerName: string, factiiiDir: string, pathEnv: string): boolean {
  try {
    // Wait for containers to stabilize
    execSync('sleep 5', { stdio: 'pipe', shell: '/bin/bash' });

    const output = execSync(
      'docker ps --filter name=' + containerName + ' --format "{{.Status}}"',
      {
        cwd: factiiiDir,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: '/bin/bash',
        env: { ...process.env, PATH: pathEnv },
      }
    );

    // Check for running containers (Status contains "Up")
    if (!output.trim()) {
      console.log('   ❌ No container found with name: ' + containerName);
      return false;
    }

    const lines = output.trim().split('\n');
    for (const line of lines) {
      if (line.includes('Exited') || line.includes('Restarting')) {
        console.log('   ❌ Container unhealthy: ' + line);
        return false;
      }
    }

    return true;
  } catch {
    console.log('   ⚠️  Could not check container health');
    return false;
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

  if (!envConfig?.domain) {
    return { success: false, error: `${environment} domain not configured` };
  }

  console.log('   🚀 Deploying on staging (' + envConfig.domain + ')...');

  // GitHub status reporting
  const sha = process.env.COMMIT_HASH ?? process.env.GITHUB_SHA ?? '';
  if (sha) {
    await reportCommitStatus(sha, 'pending', 'Deploying to staging...', 'factiii/deploy');
  }

  try {
    const repoName = config.name ?? 'app';
    const repoDir = '~/.factiii/' + repoName;

    // Determine if we're running ON the server or remotely
    // When GITHUB_ACTIONS=true or FACTIII_ON_SERVER=true, we're executing on the server itself
    const isOnServer = process.env.GITHUB_ACTIONS === 'true' || process.env.FACTIII_ON_SERVER === 'true';

    console.log('   📍 Deployment mode: ' + (isOnServer ? 'on-server' : 'remote'));

    const pathEnv = DEPLOY_PATH_PREFIX + (process.env.PATH ?? '');
    let backupPath: string | null = null;

    if (isOnServer) {
      // We're on the server - run commands directly
      const factiiiDir = path.join(process.env.HOME ?? '/Users/jon', '.factiii');
      const expandedRepoDir = repoDir.replace('~', process.env.HOME ?? '/Users/jon');

      // Step 1: Regenerate unified docker-compose.yml
      console.log('   🔄 Regenerating unified docker-compose.yml...');
      const repos = scanRepos();
      const configs = loadConfigs(repos);
      generateDockerCompose(configs);
      generateNginx(configs);

      // Step 1.5: Add postgres service for staging if DATABASE_URL is configured
      console.log('   🔄 Adding postgres service for staging...');
      await addPostgresServiceForStaging(envConfig, config);

      // Step 2: Update docker-compose.yml to use pre-built staging image
      console.log('   🔄 Updating docker-compose.yml with staging image tag...');
      await updateComposeForStagingImage(envConfig, config);

      // Step 3: Deploy using unified docker-compose.yml
      const unifiedCompose = path.join(factiiiDir, 'docker-compose.yml');
      if (!fs.existsSync(unifiedCompose)) {
        if (sha) await reportCommitStatus(sha, 'failure', 'docker-compose.yml not found', 'factiii/deploy');
        return {
          success: false,
          error: 'Unified docker-compose.yml not found. Run generate-all.js first.',
        };
      }

      // Step 4: Start postgres first and wait for it to be ready
      console.log('   🔄 Starting postgres container...');
      execSync(
        'cd ' + factiiiDir + ' && docker compose up -d postgres',
        {
          stdio: 'inherit',
          shell: '/bin/bash',
          env: { ...process.env, PATH: pathEnv },
        }
      );

      console.log('   ⏳ Waiting for postgres to be ready...');
      execSync('sleep 3', { stdio: 'inherit', shell: '/bin/bash' });

      // Step 5: Check and run Prisma migrations with backup/rollback
      const prismaSchemaPath = path.join(expandedRepoDir, config.prisma_schema ?? 'prisma/schema.prisma');

      if (fs.existsSync(prismaSchemaPath)) {
        console.log('   📋 Checking migration status...');
        const hasPending = checkPendingMigrations(expandedRepoDir, pathEnv);

        if (hasPending) {
          console.log('   📦 Pending migrations detected');

          // Step 5a: Backup database before migration
          const dbUrl = getDatabaseUrl(expandedRepoDir, 'staging');
          if (dbUrl) {
            backupPath = backupDatabase(dbUrl, 'staging', factiiiDir);
            if (!backupPath) {
              console.log('   ⚠️  Could not create backup, proceeding with migration anyway...');
            }
          } else {
            console.log('   ⚠️  DATABASE_URL not found, skipping backup');
          }

          // Step 5b: Run migrations
          console.log('   📦 Running Prisma migrations...');
          try {
            execSync(
              'cd ' + expandedRepoDir + ' && npx prisma migrate deploy',
              {
                stdio: 'inherit',
                shell: '/bin/bash',
                env: { ...process.env, PATH: pathEnv },
              }
            );
            console.log('   ✅ Prisma migrations complete');
          } catch (error) {
            // Step 5c: Migration failed - restore backup
            console.log('   ❌ Prisma migration failed');
            if (backupPath && dbUrl) {
              restoreDatabase(dbUrl, backupPath);
            }
            const msg = error instanceof Error ? error.message : String(error);
            if (sha) await reportCommitStatus(sha, 'failure', 'Migration failed', 'factiii/deploy');
            return { success: false, error: 'Migration failed: ' + msg };
          }
        } else {
          console.log('   ✅ No pending migrations');
        }
      }

      // Step 6: Manage SSL certificates
      console.log('   🔐 Managing SSL certificates...');
      await runCertbot(envConfig, config);
      await setupCertbotRenewal(envConfig);

      // Step 7: Start all containers
      console.log('   🚀 Starting containers with unified docker-compose.yml...');
      execSync(
        'cd ' + factiiiDir + ' && docker compose up -d',
        {
          stdio: 'inherit',
          shell: '/bin/bash',
          env: { ...process.env, PATH: pathEnv },
        }
      );

      // Step 8: Health check
      console.log('   🏥 Running health check...');
      const containerName = repoName;
      const isHealthy = healthCheckContainers(containerName, factiiiDir, pathEnv);

      if (!isHealthy) {
        console.log('   ❌ Containers are unhealthy after deploy');
        // Restore backup if we have one
        if (backupPath) {
          const dbUrl = getDatabaseUrl(expandedRepoDir, 'staging');
          if (dbUrl) {
            restoreDatabase(dbUrl, backupPath);
          }
        }
        if (sha) await reportCommitStatus(sha, 'failure', 'Deploy failed - containers unhealthy', 'factiii/deploy');
        return { success: false, error: 'Containers unhealthy after deploy' };
      }

      // Step 9: Cleanup backup on success
      if (backupPath && fs.existsSync(backupPath)) {
        console.log('   🗑️  Removing backup (deploy succeeded)');
        fs.unlinkSync(backupPath);
      }

    } else {
      // We're remote - SSH to the server
      // Step 1: Regenerate unified docker-compose.yml
      console.log('   🔄 Regenerating unified docker-compose.yml...');
      const repos = scanRepos();
      const configs = loadConfigs(repos);
      generateDockerCompose(configs);
      generateNginx(configs);

      // Step 1.5: Add postgres service for staging if DATABASE_URL is configured
      console.log('   🔄 Adding postgres service for staging...');
      await addPostgresServiceForStaging(envConfig, config);

      // Step 2: Update docker-compose.yml to use pre-built staging image
      console.log('   🔄 Updating docker-compose.yml with staging image tag...');
      await updateComposeForStagingImage(envConfig, config);

      // Step 3: Start postgres first and wait
      console.log('   🔄 Starting postgres container on remote server...');
      await sshExecCommand(
        envConfig,
        'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && ' +
        'cd ~/.factiii && ' +
        'docker compose up -d postgres && ' +
        'sleep 3'
      );

      // Step 4: Check migrations, backup, migrate, deploy - all via SSH
      const prismaSchema = config.prisma_schema ?? 'prisma/schema.prisma';
      console.log('   📋 Checking migrations and deploying on remote server...');
      await sshExecCommand(
        envConfig,
        'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && ' +
        'REPO_DIR=' + repoDir + ' && ' +
        'FACTIII_DIR=~/.factiii && ' +
        'PRISMA_SCHEMA=$REPO_DIR/' + prismaSchema + ' && ' +
        'if [ -f "$PRISMA_SCHEMA" ]; then ' +
        '  echo "   Checking migration status..." && ' +
        '  cd $REPO_DIR && ' +
        '  MIGRATE_OUTPUT=$(npx prisma migrate status 2>&1 || true) && ' +
        '  if echo "$MIGRATE_OUTPUT" | grep -q "have not yet been applied"; then ' +
        '    echo "   Pending migrations detected" && ' +
        '    ENV_FILE=$REPO_DIR/.env.staging && ' +
        '    if [ -f "$ENV_FILE" ]; then ' +
        '      DB_URL=$(grep "^DATABASE_URL=" "$ENV_FILE" | sed "s/^DATABASE_URL=//" | sed "s/^[\\\"\\x27]//;s/[\\\"\\x27]$//") && ' +
        '      if [ -n "$DB_URL" ]; then ' +
        '        BACKUP_FILE=$FACTIII_DIR/backup-staging-$(date +%Y-%m-%dT%H-%M-%S).tar.gz && ' +
        '        echo "   Creating database backup..." && ' +
        '        pg_dump -Ft "$DB_URL" > "$BACKUP_FILE" && ' +
        '        echo "   Backup created: $BACKUP_FILE" && ' +
        '        echo "   Running migrations..." && ' +
        '        if npx prisma migrate deploy; then ' +
        '          echo "   Migrations complete" && ' +
        '          rm -f "$BACKUP_FILE" && ' +
        '          echo "   Backup cleaned up"; ' +
        '        else ' +
        '          echo "   Migration failed - restoring backup..." && ' +
        '          pg_restore --clean --if-exists -d "$DB_URL" "$BACKUP_FILE" && ' +
        '          echo "   Database restored" && ' +
        '          exit 1; ' +
        '        fi; ' +
        '      else echo "   DATABASE_URL not found, skipping backup"; npx prisma migrate deploy || true; fi; ' +
        '    else echo "   .env.staging not found, skipping backup"; npx prisma migrate deploy || true; fi; ' +
        '  else ' +
        '    echo "   No pending migrations"; ' +
        '  fi; ' +
        'fi'
      );

      // Step 5: Manage SSL certificates
      console.log('   🔐 Managing SSL certificates on remote server...');
      await runCertbot(envConfig, config);
      await setupCertbotRenewal(envConfig);

      // Step 6: Deploy and health check
      console.log('   🚀 Starting containers on remote server...');
      await sshExecCommand(
        envConfig,
        'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && ' +
        'if [ ! -f ~/.factiii/docker-compose.yml ]; then ' +
        '  echo "docker-compose.yml not found" && exit 1; ' +
        'fi && ' +
        'cd ~/.factiii && ' +
        'docker compose up -d && ' +
        'sleep 5 && ' +
        'echo "Health check..." && ' +
        'docker ps --filter name=' + repoName + ' --format "{{.Status}}" | ' +
        'while read status; do ' +
        '  if echo "$status" | grep -qE "Exited|Restarting"; then ' +
        '    echo "Container unhealthy: $status" && exit 1; ' +
        '  fi; ' +
        'done && ' +
        'echo "Containers healthy"'
      );
    }

    // Report success to GitHub
    if (sha) {
      await reportCommitStatus(sha, 'success', 'Staging deploy succeeded', 'factiii/deploy');
    }
    return { success: true, message: 'Staging deployment complete' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error('   ❌ Deployment failed: ' + errorMessage);
    // Report failure to GitHub
    if (sha) {
      await reportCommitStatus(sha, 'failure', 'Staging deploy failed', 'factiii/deploy');
    }
    return {
      success: false,
      error: errorMessage,
    };
  }
}

