/**
 * Mac Mini Server Plugin
 *
 * Deploys containers to a Mac Mini server via SSH.
 * Typically used for staging environments (local network or Tailscale).
 * Supports dev stage for local Docker development.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';

import { sshExec } from '../../../utils/ssh-helper.js';
import type {
  FactiiiConfig,
  EnvironmentConfig,
  Fix,
  DeployResult,
  EnsureServerReadyOptions,
} from '../../../types/index.js';

interface AutoConfig {
  package_manager?: string;
}

class MacMiniPlugin {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'mac-mini';
  static readonly name = 'Mac Mini Server';
  static readonly category: 'server' = 'server';
  static readonly version = '1.0.0';

  // Env vars this plugin requires
  static readonly requiredEnvVars: string[] = [];

  // Schema for factiii.yml (user-editable)
  static readonly configSchema: Record<string, unknown> = {
    // No user config needed - uses environments.staging.host
  };

  // Schema for factiiiAuto.yml (auto-detected)
  static readonly autoConfigSchema: Record<string, string> = {
    ssh_user: 'string',
  };

  /**
   * Determine if this plugin should be loaded for this project
   * Loads if config has staging host with local/private IP, or on init (no config)
   */
  static async shouldLoad(_rootDir: string, config: FactiiiConfig): Promise<boolean> {
    // If explicitly configured as mac-mini server
    if (config?.environments?.staging?.server === 'mac-mini') {
      return true;
    }

    // If config exists with staging host, check if it's local/private IP
    const stagingHost = config?.environments?.staging?.host;
    if (stagingHost && !stagingHost.startsWith('EXAMPLE-')) {
      // Check if it's a local/private IP (192.168.x.x, 10.x.x.x, 172.16-31.x.x)
      return /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(stagingHost);
    }

    // On init (no config or EXAMPLE values), load as default staging option
    return Object.keys(config).length === 0 || !config.environments;
  }

  static helpText: Record<string, string> = {
    SSH: `
   SSH private key for accessing the server.
   
   Step 1: Generate a new SSH key pair (if needed):
   ssh-keygen -t ed25519 -C "deploy-key" -f ~/.ssh/deploy_key
   
   Step 2: Add PUBLIC key to server:
   ssh-copy-id -i ~/.ssh/deploy_key.pub ubuntu@YOUR_HOST
   
   Step 3: Paste the PRIVATE key below (multi-line, end with blank line):
   cat ~/.ssh/deploy_key`,
  };

  // ============================================================
  // FIXES - All issues this plugin can detect and resolve
  // ============================================================

  static readonly fixes: Fix[] = [
    // DEV STAGE FIXES - Local development
    {
      id: 'docker-not-installed-dev',
      stage: 'dev',
      severity: 'critical',
      description: 'Docker is not installed locally',
      scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        try {
          execSync('which docker', { stdio: 'pipe' });
          return false; // No problem
        } catch {
          return true; // Problem exists
        }
      },
      fix: null,
      manualFix: 'Install Docker Desktop: https://www.docker.com/products/docker-desktop/',
    },
    {
      id: 'docker-not-running-dev',
      stage: 'dev',
      severity: 'critical',
      description: 'Docker is not running locally',
      scan: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        try {
          execSync('docker info', { stdio: 'pipe' });
          return false; // No problem
        } catch {
          return true; // Problem exists
        }
      },
      fix: async (_config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        try {
          // Double-check Docker isn't already running
          try {
            execSync('docker info', { stdio: 'pipe' });
            console.log('✅ Docker is already running');
            return true; // Already running, nothing to fix
          } catch {
            // Docker not running, proceed to start it
          }
          
          console.log('🐳 Starting Docker Desktop...');
          execSync('open -a Docker', { stdio: 'inherit' });
          
          // Wait for Docker to start (up to 30 seconds)
          for (let i = 0; i < 30; i++) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            try {
              execSync('docker info', { stdio: 'pipe' });
              console.log('✅ Docker started successfully');
              return true;
            } catch {
              // Still starting...
            }
          }
          
          console.log('❌ Docker failed to start within 30 seconds');
          console.log('💡 Try starting Docker Desktop manually');
          return false; // Failed to start
        } catch (error) {
          console.error('❌ Failed to start Docker:', error);
          return false;
        }
      },
      manualFix: 'Start Docker Desktop or run: open -a Docker',
    },
    {
      id: 'missing-dockerfile-dev',
      stage: 'dev',
      severity: 'warning',
      description: 'Dockerfile not found',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const commonPaths = [
          'Dockerfile',
          'apps/server/Dockerfile',
          'packages/server/Dockerfile',
        ];
        for (const p of commonPaths) {
          if (fs.existsSync(path.join(rootDir, p))) return false;
        }
        return true;
      },
      fix: null,
      manualFix: 'Create a Dockerfile for your application',
    },
    {
      id: 'missing-docker-compose-dev',
      stage: 'dev',
      severity: 'info',
      description: 'docker-compose.yml not found (optional for dev)',
      scan: async (_config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        return (
          !fs.existsSync(path.join(rootDir, 'docker-compose.yml')) &&
          !fs.existsSync(path.join(rootDir, 'compose.yml'))
        );
      },
      fix: null,
      manualFix: 'Create docker-compose.yml for local development (optional)',
    },

    // STAGING STAGE FIXES
    {
      id: 'staging-host-missing',
      stage: 'staging',
      severity: 'critical',
      description: 'Staging host not configured in factiii.yml',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Only check if staging environment is defined in config
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false; // Skip check if staging not configured

        return !config?.environments?.staging?.host;
      },
      fix: null,
      manualFix: 'Add environments.staging.host to factiii.yml',
    },
    {
      id: 'staging-unreachable',
      stage: 'staging',
      severity: 'critical',
      description: 'Cannot reach staging server',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Only check if staging environment is defined in config
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false; // Skip check if staging not configured

        const host = config?.environments?.staging?.host;
        if (!host) return false; // Will be caught by staging-host-missing

        try {
          // Try to ping the host
          execSync(`ping -c 1 -W 3 ${host}`, { stdio: 'pipe' });
          return false;
        } catch {
          return true;
        }
      },
      fix: null,
      manualFix: 'Check network connectivity to staging server',
    },
    // ============================================================
    // CRITICAL: NO SSH IN FIX FUNCTIONS
    // ============================================================
    // SSH keys for staging/prod are ONLY in GitHub Secrets, NOT on dev machines.
    // Dev machine CANNOT SSH to staging/prod.
    // Workflows SSH ONCE and run CLI with --on-server flag.
    // When --on-server is set, fix functions run locally (we're already on the server).
    // NEVER add isOnServer checks or SSH calls to individual fix functions.
    // CLI handles execution context at the wrapper level.
    // ============================================================
    {
      id: 'staging-docker-missing',
      stage: 'staging',
      severity: 'critical',
      description: 'Docker not installed on staging server',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Only check if staging environment is defined in config
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false; // Skip check if staging not configured

        const host = config?.environments?.staging?.host;
        if (!host) return false;

        // Executed locally - SSH handled by CLI wrapper
        try {
          execSync('which docker', { stdio: 'pipe' });
          return false; // Docker is installed
        } catch {
          return true; // Docker is not installed
        }
      },
      fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Executed locally - SSH handled by CLI wrapper
        console.log('   Installing Docker on staging server...');
        try {
          execSync('brew install --cask docker || (curl -fsSL https://get.docker.com | sh)', { stdio: 'inherit' });
          return true;
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`   Failed: ${errorMessage}`);
          return false;
        }
      },
      manualFix: 'SSH to server and install Docker: brew install --cask docker',
    },
    {
      id: 'staging-docker-not-running',
      stage: 'staging',
      severity: 'critical',
      description: 'Docker is not running on staging server',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Only check if staging environment is defined in config
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false; // Skip check if staging not configured

        const host = config?.environments?.staging?.host;
        if (!host) return false;

        // Executed locally - SSH handled by CLI wrapper
        try {
          execSync('docker info', { stdio: 'pipe' });
          return false; // Docker is running
        } catch {
          return true; // Docker is not running
        }
      },
      fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Executed locally - SSH handled by CLI wrapper
        try {
          // Double-check Docker isn't already running
          try {
            execSync('docker info', { stdio: 'pipe' });
            console.log('   ✅ Docker is already running');
            return true;
          } catch {
            // Docker not running, proceed to start it
          }
          
          console.log('   🐳 Starting Docker Desktop on staging server...');
          execSync('open -a Docker && sleep 15 && docker info', { stdio: 'inherit' });
          console.log('   ✅ Docker Desktop started successfully');
          return true;
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`   ❌ Failed to start Docker: ${errorMessage}`);
          return false;
        }
      },
      manualFix: 'SSH to server and run: open -a Docker',
    },
    {
      id: 'staging-docker-autostart',
      stage: 'staging',
      severity: 'warning',
      description: 'Docker not configured to start on login',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Only check if staging environment is defined in config
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false; // Skip check if staging not configured

        const host = config?.environments?.staging?.host;
        if (!host) return false;

        // If Docker is running, don't worry about autostart config
        try {
          execSync('docker info', { stdio: 'pipe', timeout: 5000 });
          return false; // Docker is running, no need to check autostart
        } catch {
          // Docker not running, check if it's configured to autostart
        }

        // Check LaunchAgents plist file instead of using AppleScript
        // AppleScript doesn't work reliably over SSH (no GUI access)
        try {
          const homeDir = process.env.HOME ?? '/Users/jon';
          const plistPath = `${homeDir}/Library/LaunchAgents/com.docker.helper.plist`;
          return !fs.existsSync(plistPath);
        } catch {
          // If we can't check, assume it's not a problem
          return false;
        }
      },
      fix: null, // Cannot reliably fix via SSH - requires GUI access
      manualFix:
        'Add Docker to Login Items: System Settings → General → Login Items → Add Docker',
    },
    {
      id: 'staging-old-containers',
      stage: 'staging',
      severity: 'warning',
      description: 'Old Docker containers not managed by current factiii configs',
      scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false;

        try {
          // 1. Generate configs first to know what SHOULD be running
          const factiiiDir = path.join(process.env.HOME ?? '/Users/jon', '.factiii');
          const infraDir = path.join(factiiiDir, 'infrastructure');
          const generateScript = path.join(infraDir, 'dist', 'scripts', 'generate-all.js');

          if (fs.existsSync(generateScript)) {
            execSync(`node "${generateScript}"`, { stdio: 'pipe', cwd: factiiiDir });
          }

          // 2. Get list of managed containers from generated docker-compose.yml
          const composeFile = path.join(factiiiDir, 'docker-compose.yml');
          if (!fs.existsSync(composeFile)) {
            return false; // No compose file, nothing to check
          }

          const composeContent = fs.readFileSync(composeFile, 'utf8');
          const compose = yaml.load(composeContent) as { services?: Record<string, unknown> };
          const managedContainers = Object.keys(compose.services ?? {});

          // 3. Get running containers
          const running = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf8' })
            .split('\n')
            .filter(Boolean);

          // 4. Find unmanaged containers (exclude postgres, nginx, infrastructure, supabase)
          const unmanaged = running.filter(
            (name) =>
              !managedContainers.includes(name) &&
              !name.toLowerCase().includes('db') &&
              !name.toLowerCase().includes('postgres') &&
              !name.toLowerCase().includes('nginx') &&
              !name.toLowerCase().includes('supabase') &&
              !name.includes('infrastructure') &&
              !name.match(/^(Dev|Test|dev|test)$/) // Exact match for common DB container names
          );

          return unmanaged.length > 0;
        } catch {
          return false; // If we can't check, assume no problem
        }
      },
      fix: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        try {
          // Same logic as scan to find unmanaged containers
          const factiiiDir = path.join(process.env.HOME ?? '/Users/jon', '.factiii');
          const infraDir = path.join(factiiiDir, 'infrastructure');
          const generateScript = path.join(infraDir, 'dist', 'scripts', 'generate-all.js');

          if (fs.existsSync(generateScript)) {
            console.log('   🔨 Generating configs to determine managed containers...');
            execSync(`node "${generateScript}"`, { stdio: 'inherit', cwd: factiiiDir });
          }

          const composeFile = path.join(factiiiDir, 'docker-compose.yml');
          if (!fs.existsSync(composeFile)) {
            console.log('   ⚠️  No docker-compose.yml found, skipping cleanup');
            return false;
          }

          const composeContent = fs.readFileSync(composeFile, 'utf8');
          const compose = yaml.load(composeContent) as { services?: Record<string, unknown> };
          const managedContainers = Object.keys(compose.services ?? {});

          const running = execSync('docker ps --format "{{.Names}}"', { encoding: 'utf8' })
            .split('\n')
            .filter(Boolean);

          const unmanaged = running.filter(
            (name) =>
              !managedContainers.includes(name) &&
              !name.toLowerCase().includes('db') &&
              !name.toLowerCase().includes('postgres') &&
              !name.toLowerCase().includes('nginx') &&
              !name.toLowerCase().includes('supabase') &&
              !name.includes('infrastructure') &&
              !name.match(/^(Dev|Test|dev|test)$/) // Exact match for common DB container names
          );

          if (unmanaged.length === 0) {
            console.log('   ✅ No unmanaged containers found');
            return true;
          }

          console.log(`   🧹 Stopping ${unmanaged.length} unmanaged container(s):`);
          for (const container of unmanaged) {
            console.log(`      - ${container}`);
            execSync(`docker stop "${container}"`, { stdio: 'inherit' });
          }

          console.log('   ✅ Cleanup complete');
          return true;
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`   Failed to clean up containers: ${errorMessage}`);
          return false;
        }
      },
      manualFix: 'Run: npx factiii fix --staging (will stop unmanaged containers)',
    },
    {
      id: 'staging-node-missing',
      stage: 'staging',
      severity: 'critical',
      description: 'Node.js not installed on staging server',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false;

        const host = config?.environments?.staging?.host;
        if (!host) return false;

        // Executed locally - SSH handled by CLI wrapper
        try {
          execSync('which node', { stdio: 'pipe' });
          return false; // Node.js is installed
        } catch {
          return true; // Node.js is not installed
        }
      },
      fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Executed locally - SSH handled by CLI wrapper
        console.log('   Installing Node.js on staging server...');
        try {
          execSync('brew install node || (curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs)', { stdio: 'inherit' });
          return true;
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`   Failed: ${errorMessage}`);
          return false;
        }
      },
      manualFix:
        'SSH to server and install Node.js: brew install node (Mac) or use NodeSource (Linux)',
    },
    {
      id: 'staging-git-missing',
      stage: 'staging',
      severity: 'critical',
      description: 'Git not installed on staging server',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false;

        const host = config?.environments?.staging?.host;
        if (!host) return false;

        // Executed locally - SSH handled by CLI wrapper
        try {
          execSync('which git', { stdio: 'pipe' });
          return false; // git is installed
        } catch {
          return true; // git is not installed
        }
      },
      fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Executed locally - SSH handled by CLI wrapper
        console.log('   Installing git on staging server...');
        try {
          execSync('brew install git || sudo apt-get install -y git', { stdio: 'inherit' });
          return true;
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`   Failed: ${errorMessage}`);
          return false;
        }
      },
      manualFix:
        'SSH to server and install git: brew install git (Mac) or sudo apt-get install git (Linux)',
    },
    {
      id: 'staging-pnpm-missing',
      stage: 'staging',
      severity: 'warning',
      description: 'pnpm not installed on staging server',
      scan: async (config: FactiiiConfig, rootDir: string): Promise<boolean> => {
        // Only check if staging environment is defined in config
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false;

        // Only check if project uses pnpm
        const autoConfigPath = path.join(rootDir, 'factiiiAuto.yml');
        if (!fs.existsSync(autoConfigPath)) return false;

        try {
          const autoConfig = yaml.load(
            fs.readFileSync(autoConfigPath, 'utf8')
          ) as AutoConfig | null;
          if (autoConfig?.package_manager !== 'pnpm') return false;
        } catch {
          return false;
        }

        const host = config?.environments?.staging?.host;
        if (!host) return false;

        // Executed locally - SSH handled by CLI wrapper
        try {
          execSync('which pnpm', { stdio: 'pipe' });
          return false; // pnpm is installed
        } catch {
          return true; // pnpm is not installed
        }
      },
      fix: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        // Executed locally - SSH handled by CLI wrapper
        console.log('   Installing pnpm on staging server...');
        try {
          execSync('npm install -g pnpm@9', { stdio: 'inherit' });
          return true;
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          console.log(`   Failed: ${errorMessage}`);
          return false;
        }
      },
      manualFix: 'SSH to server and run: npm install -g pnpm@9',
    },
    {
      id: 'staging-repo-not-cloned',
      stage: 'staging',
      severity: 'warning',
      description: 'Repository not cloned on staging server',
      scan: async (config: FactiiiConfig, _rootDir: string): Promise<boolean> => {
        const hasStagingEnv = config?.environments?.staging;
        if (!hasStagingEnv) return false;

        const host = config?.environments?.staging?.host;
        if (!host) return false;

        const repoName = config.name ?? 'app';

        // Executed locally - SSH handled by CLI wrapper
        try {
          const repoPath = path.join(process.env.HOME ?? '/Users/jon', '.factiii', repoName, '.git');
          return !fs.existsSync(repoPath);
        } catch {
          return true;
        }
      },
      fix: null, // Will be handled by ensureServerReady()
      manualFix: 'Repository will be cloned automatically on first deployment',
    },
  ];

  // ============================================================
  // STATIC HELPER METHODS
  // ============================================================

  /**
   * Auto-detect Mac Mini configuration
   */
  static async detectConfig(_rootDir: string): Promise<{ ssh_user: string }> {
    return {
      ssh_user: 'ubuntu', // Default SSH user
    };
  }

  /**
   * Execute a command on a remote server via SSH
   */
  static async sshExec(envConfig: EnvironmentConfig, command: string): Promise<string> {
    return await sshExec(envConfig, command);
  }

  // ============================================================
  // INSTANCE METHODS
  // ============================================================

  private _config: FactiiiConfig;

  constructor(config: FactiiiConfig) {
    this._config = config;
  }

  /**
   * Ensure server is ready for deployment
   * Installs Node.js, git, pnpm, clones repo, checks out commit
   */
  async ensureServerReady(
    config: FactiiiConfig,
    environment: string,
    options: EnsureServerReadyOptions = {}
  ): Promise<DeployResult> {
    if (environment !== 'staging') {
      return { success: true, message: 'Mac Mini only handles staging' };
    }

    const envConfig = config.environments?.staging;
    if (!envConfig?.host) {
      throw new Error('Staging host not configured');
    }

    const { commitHash, branch = 'main', repoUrl } = options;
    const repoName = config.name ?? 'app';
    const repoDir = `~/.factiii/${repoName}`;

    try {
      // 1. Ensure Node.js is installed
      console.log('   Checking Node.js...');
      await this.ensureNodeInstalled(envConfig);

      // 2. Ensure git is installed
      console.log('   Checking git...');
      await this.ensureGitInstalled(envConfig);

      // 3. Ensure repo is cloned and up to date
      console.log('   Syncing repository...');
      await this.ensureRepoCloned(envConfig, repoUrl, repoDir, repoName);
      await this.pullAndCheckout(envConfig, repoDir, branch, commitHash);

      // 4. Ensure pnpm is installed
      console.log('   Checking pnpm...');
      await this.ensurePnpmInstalled(envConfig);

      // 5. Install dependencies
      console.log('   Installing dependencies...');
      await this.installDependencies(envConfig, repoDir);

      return { success: true, message: 'Server ready' };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to prepare server: ${errorMessage}`);
    }
  }

  /**
   * Ensure Node.js is installed on the server
   */
  private async ensureNodeInstalled(envConfig: EnvironmentConfig): Promise<void> {
    try {
      await MacMiniPlugin.sshExec(envConfig, 'which node');
    } catch {
      console.log('      Installing Node.js...');
      await MacMiniPlugin.sshExec(
        envConfig,
        'brew install node || (curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs)'
      );
    }
  }

  /**
   * Ensure git is installed on the server
   */
  private async ensureGitInstalled(envConfig: EnvironmentConfig): Promise<void> {
    try {
      await MacMiniPlugin.sshExec(envConfig, 'which git');
    } catch {
      console.log('      Installing git...');
      await MacMiniPlugin.sshExec(envConfig, 'brew install git || sudo apt-get install -y git');
    }
  }

  /**
   * Ensure pnpm is installed on the server
   */
  private async ensurePnpmInstalled(envConfig: EnvironmentConfig): Promise<void> {
    try {
      await MacMiniPlugin.sshExec(envConfig, 'which pnpm');
    } catch {
      console.log('      Installing pnpm...');
      await MacMiniPlugin.sshExec(envConfig, 'npm install -g pnpm@9');
    }
  }

  /**
   * Ensure repository is cloned
   */
  private async ensureRepoCloned(
    envConfig: EnvironmentConfig,
    repoUrl: string | undefined,
    repoDir: string,
    repoName: string
  ): Promise<void> {
    const checkExists = await MacMiniPlugin.sshExec(
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

      await MacMiniPlugin.sshExec(
        envConfig,
        `mkdir -p ~/.factiii && cd ~/.factiii && git clone ${gitUrl} ${repoName}`
      );
    }
  }

  /**
   * Pull latest changes and checkout specific commit
   */
  private async pullAndCheckout(
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

    await MacMiniPlugin.sshExec(envConfig, commands.join(' && '));
  }

  /**
   * Install dependencies using pnpm
   */
  private async installDependencies(
    envConfig: EnvironmentConfig,
    repoDir: string
  ): Promise<void> {
    await MacMiniPlugin.sshExec(envConfig, `cd ${repoDir} && pnpm install`);
  }

  /**
   * Ensure Docker is running before deployment
   * Starts Docker Desktop if not running and waits for it to be ready
   */
  private async ensureDockerRunning(
    envConfig: EnvironmentConfig,
    isOnServer: boolean
  ): Promise<void> {
    const checkCmd = 'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && docker info > /dev/null 2>&1 && echo "running" || echo "stopped"';
    
    // Start Docker and wait up to 60 seconds for it to be ready
    const startCmd = `
      export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && \
      if ! docker info > /dev/null 2>&1; then
        echo "Starting Docker Desktop..." && \
        open -a Docker && \
        for i in {1..60}; do
          sleep 1
          if docker info > /dev/null 2>&1; then
            echo "Docker is ready"
            exit 0
          fi
        done
        echo "Docker failed to start within 60 seconds"
        exit 1
      else
        echo "Docker is already running"
      fi
    `;

    if (isOnServer) {
      // We're on the server - run commands directly
      try {
        const result = execSync(checkCmd, { 
          encoding: 'utf8', 
          shell: '/bin/bash',
          env: {
            ...process.env,
            PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
          },
        });
        
        if (result.includes('stopped')) {
          console.log('   🐳 Starting Docker Desktop...');
          execSync(startCmd, { 
            stdio: 'inherit', 
            shell: '/bin/bash',
            env: {
              ...process.env,
              PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
            },
          });
          console.log('   ✅ Docker Desktop started');
        } else {
          console.log('   ✅ Docker is already running');
        }
      } catch (error) {
        // Docker not running, try to start it
        console.log('   🐳 Starting Docker Desktop...');
        try {
          execSync(startCmd, { 
            stdio: 'inherit', 
            shell: '/bin/bash',
            env: {
              ...process.env,
              PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
            },
          });
          console.log('   ✅ Docker Desktop started');
        } catch (startError) {
          throw new Error('Failed to start Docker Desktop. Please start it manually.');
        }
      }
    } else {
      // We're remote - run via SSH
      try {
        const result = await MacMiniPlugin.sshExec(envConfig, checkCmd);
        if (result.includes('stopped')) {
          console.log('   🐳 Starting Docker Desktop on staging server...');
          await MacMiniPlugin.sshExec(envConfig, startCmd);
          console.log('   ✅ Docker Desktop started');
        } else {
          console.log('   ✅ Docker is already running');
        }
      } catch {
        console.log('   🐳 Starting Docker Desktop on staging server...');
        try {
          await MacMiniPlugin.sshExec(envConfig, startCmd);
          console.log('   ✅ Docker Desktop started');
        } catch (startError) {
          throw new Error('Failed to start Docker Desktop on staging server. Please start it manually.');
        }
      }
    }
  }

  /**
   * Deploy to an environment
   */
  async deploy(config: FactiiiConfig, environment: string): Promise<DeployResult> {
    if (environment === 'dev') {
      return this.deployDev();
    } else if (environment === 'staging') {
      return this.deployStaging(config);
    }

    return { success: false, error: `Unsupported environment: ${environment}` };
  }

  /**
   * Deploy to local dev environment
   */
  private async deployDev(): Promise<DeployResult> {
    console.log('   🐳 Starting local dev containers...');

    try {
      // Check for docker-compose file
      const composeFile = fs.existsSync('docker-compose.yml')
        ? 'docker-compose.yml'
        : fs.existsSync('compose.yml')
          ? 'compose.yml'
          : null;

      if (composeFile) {
        execSync(`docker compose -f ${composeFile} up -d`, { stdio: 'inherit' });
        return { success: true, message: 'Local containers started' };
      } else {
        console.log('   No docker-compose.yml found, skipping container start');
        return { success: true, message: 'No compose file, skipped' };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Generate docker-compose.staging.yml for staging deployment
   */
  private generateStagingCompose(config: FactiiiConfig): string {
    const repoName = config.name ?? 'app';

    return `services:
  postgres:
    image: postgres:latest
    container_name: ${repoName}-postgres-staging
    restart: always
    environment:
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=\${POSTGRES_PASSWORD:-password}
      - POSTGRES_DB=${repoName}-staging
    ports:
      - "5432:5432"
    volumes:
      - postgres-staging:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5

  server:
    build:
      context: .
      dockerfile: apps/server/Dockerfile
    container_name: ${repoName}-staging
    restart: always
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://postgres:\${POSTGRES_PASSWORD:-password}@postgres:5432/${repoName}-staging
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  postgres-staging:
`;
  }

  private async deployStaging(config: FactiiiConfig): Promise<DeployResult> {
    // ============================================================
    // CRITICAL: Deployment Flow - Staging vs Production
    // ============================================================
    // STAGING (this method):
    //   - Workflow SSHes to staging server
    //   - Runs: deploy --staging --on-server
    //   - Builds container locally from source
    //   - Deploys locally-built container (factiii-staging)
    //
    // PRODUCTION (different flow):
    //   - Workflow SSHes to STAGING server (not prod!)
    //   - Builds production image on staging
    //   - Pushes to ECR
    //   - Workflow SSHes to prod server
    //   - Pulls from ECR and deploys
    //
    // Why workflows SSH first: Allows using GitHub Secrets (SSH keys)
    // without storing them on servers. Workflow passes secrets via SSH.
    //
    // Why --on-server flag exists: Tells CLI we're already on target
    // server, so don't SSH again (would cause infinite loops).
    //
    // Why both paths exist: Code checks GITHUB_ACTIONS env var:
    //   - GITHUB_ACTIONS=true → on-server path (Factiii workflows)
    //   - GITHUB_ACTIONS not set → remote SSH path (other workflows)
    //
    // What breaks if changed: Removing --on-server causes SSH loops.
    // Removing remote SSH path breaks non-Factiii workflow compatibility.
    // ============================================================

    const envConfig = config.environments?.staging;
    if (!envConfig?.host) {
      return { success: false, error: 'Staging host not configured' };
    }

    console.log(`   🔨 Building and deploying on staging (${envConfig.host})...`);

    try {
      const repoName = config.name ?? 'app';
      const repoDir = `~/.factiii/${repoName}`;
      const composeContent = this.generateStagingCompose(config);

      // Determine if we're running ON the server or remotely
      // When GITHUB_ACTIONS=true, we're executing on the server itself
      const isOnServer = process.env.GITHUB_ACTIONS === 'true';

      console.log(`   📍 Deployment mode: ${isOnServer ? 'on-server' : 'remote'}`);

      // ============================================================
      // CRITICAL: Ensure Docker is running BEFORE building
      // ============================================================
      // Why this exists: Staging builds containers locally from source.
      // Unlike production (which pulls pre-built images from ECR),
      // staging needs Docker daemon running to build the images.
      // What breaks if changed: docker compose build fails with
      // "Cannot connect to the Docker daemon" error.
      // Dependencies: Docker Desktop must be installed and startable.
      // ============================================================
      console.log('   🐳 Checking Docker status...');
      await this.ensureDockerRunning(envConfig, isOnServer);

      if (isOnServer) {
        // We're on the server - run commands directly
        const expandedRepoDir = repoDir.replace('~', process.env.HOME ?? '');

        console.log(`   📝 Writing docker-compose.staging.yml to ${expandedRepoDir}`);
        // Write docker-compose.staging.yml
        fs.writeFileSync(
          path.join(expandedRepoDir, 'docker-compose.staging.yml'),
          composeContent
        );

        // ============================================================
        // CRITICAL: Build BEFORE Deploy
        // ============================================================
        // Why: docker compose up --build doesn't reliably build images
        // that don't exist yet. It tries to start the container first,
        // fails with "unable to get image", then tries to build.
        //
        // What breaks: Deployment fails with Docker daemon errors.
        //
        // Solution: Always build explicitly first, then deploy.
        // ============================================================

        // Step 1: Build the image
        console.log('   🔨 Building container image...');
        execSync(
          `cd ${expandedRepoDir} && docker compose -f docker-compose.staging.yml build`,
          {
            stdio: 'inherit',
            shell: '/bin/bash',
            env: {
              ...process.env,
              PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
            },
          }
        );

        // Step 2: Deploy using unified compose (if available)
        const factiiiDir = path.join(process.env.HOME ?? '/Users/jon', '.factiii');
        const unifiedCompose = path.join(factiiiDir, 'docker-compose.yml');
        
        if (fs.existsSync(unifiedCompose)) {
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
          // Fallback to single-repo compose
          console.log('   🚀 Starting containers with single-repo docker-compose.staging.yml...');
          execSync(
            `cd ${expandedRepoDir} && docker compose -f docker-compose.staging.yml up -d`,
            {
              stdio: 'inherit',
              shell: '/bin/bash',
              env: {
                ...process.env,
                PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`,
              },
            }
          );
        }
      } else {
        // We're remote - SSH to the server
        console.log('   📝 Writing docker-compose.staging.yml to remote server');
        
        await MacMiniPlugin.sshExec(
          envConfig,
          `cat > ${repoDir}/docker-compose.staging.yml << 'EOF'\n${composeContent}\nEOF`
        );

        // ============================================================
        // CRITICAL: Build BEFORE Deploy
        // ============================================================
        // Why: docker compose up --build doesn't reliably build images
        // that don't exist yet. It tries to start the container first,
        // fails with "unable to get image", then tries to build.
        //
        // What breaks: Deployment fails with Docker daemon errors.
        //
        // Solution: Always build explicitly first, then deploy.
        // ============================================================

        // Step 1: Build the image
        console.log('   🔨 Building container image on remote server...');
        await MacMiniPlugin.sshExec(
          envConfig,
          `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && \
           cd ${repoDir} && \
           docker compose -f docker-compose.staging.yml build`
        );

        // Step 2: Deploy using unified compose (if available)
        console.log('   🚀 Starting containers on remote server...');
        await MacMiniPlugin.sshExec(
          envConfig,
          `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" && \
           if [ -f ~/.factiii/docker-compose.yml ]; then \
             echo "Using unified docker-compose.yml" && \
             cd ~/.factiii && \
             docker compose up -d; \
           else \
             echo "Using single-repo docker-compose.staging.yml" && \
             cd ${repoDir} && \
             docker compose -f docker-compose.staging.yml up -d; \
           fi`
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

  /**
   * Undeploy from an environment
   */
  async undeploy(config: FactiiiConfig, environment: string): Promise<DeployResult> {
    if (environment === 'dev') {
      try {
        execSync('docker compose down', { stdio: 'inherit' });
        return { success: true, message: 'Local containers stopped' };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    } else if (environment === 'staging') {
      const envConfig = config.environments?.staging;
      if (!envConfig?.host) {
        return { success: false, error: 'Staging host not configured' };
      }

      try {
        const repoName = config.name ?? 'app';
        await MacMiniPlugin.sshExec(
          envConfig,
          `
          cd ~/.factiii && docker compose stop ${repoName}-staging
        `
        );
        return { success: true, message: 'Staging containers stopped' };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return { success: false, error: `Unsupported environment: ${environment}` };
  }
}

export default MacMiniPlugin;

