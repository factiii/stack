import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { getStackConfigPath } from '../constants/config-files.js';
import { AnsibleVaultSecrets } from '../utils/ansible-vault-secrets.js';
import { SSHDeploy } from '../utils/ssh-deploy.js';
import type { FactiiiConfig, EnvironmentConfig } from '../types/index.js';
import { extractEnvironments } from '../utils/config-helpers.js';

export interface DeploySecretsOptions {
    rootDir?: string;
    restart?: boolean;  // Restart containers after deploying
    dryRun?: boolean;   // Show what would be deployed without deploying
}

export interface DeploySecretsResult {
    success: boolean;
    message?: string;
    error?: string;
}

/**
 * Load configuration from stack.yml (or legacy factiii.yml)
 */
function loadConfig(rootDir: string): FactiiiConfig {
    const configPath = getStackConfigPath(rootDir);
    if (!fs.existsSync(configPath)) {
        throw new Error('stack.yml not found. Run: npx factiii init');
    }
    try {
        return (yaml.load(fs.readFileSync(configPath, 'utf8')) as FactiiiConfig) ?? ({} as FactiiiConfig);
    } catch (e) {
        throw new Error('Error parsing config: ' + (e instanceof Error ? e.message : String(e)));
    }
}

/**
 * Get stage type from environment name
 */
function getStageType(envName: string): 'staging' | 'prod' | null {
    if (envName.startsWith('staging')) return 'staging';
    if (envName.startsWith('prod')) return 'prod';
    return null;
}

/**
 * Deploy secrets to a single environment
 */
async function deployToEnvironment(
    stage: 'staging' | 'prod',
    envConfig: EnvironmentConfig,
    config: FactiiiConfig,
    store: AnsibleVaultSecrets,
    options: DeploySecretsOptions
): Promise<DeploySecretsResult> {
    console.log(`\nDeploying secrets to ${stage}...`);

    // Get SSH key
    const sshKey = await store.getSSHKey(stage);
    if (!sshKey) {
        return {
            success: false,
            error: `No SSH key found for ${stage}. Run: npx factiii secrets set ${stage.toUpperCase()}_SSH`
        };
    }

    // Get environment secrets
    const envSecrets = await store.getEnvironmentSecrets(stage);
    if (Object.keys(envSecrets).length === 0) {
        console.log(`  [!] No environment secrets found for ${stage}`);
        console.log(`      Add secrets with: npx factiii secrets set-env <NAME> --${stage}`);
        return {
            success: true,
            message: `No secrets to deploy for ${stage}`,
        };
    }

    console.log(`  Found ${Object.keys(envSecrets).length} environment variables`);
    for (const key of Object.keys(envSecrets)) {
        console.log(`    - ${key}`);
    }

    if (options.dryRun) {
        console.log(`  [DRY RUN] Would deploy to ${envConfig.domain}`);
        return {
            success: true,
            message: `Dry run complete for ${stage}`,
        };
    }

    // Create SSH deploy instance
    const sshDeploy = new SSHDeploy({
        host: envConfig.domain,
        user: envConfig.ssh_user ?? 'ubuntu',
        privateKey: sshKey,
        repoName: config.name,
    });

    // Test connection
    console.log(`  Connecting to ${envConfig.domain}...`);
    const connected = await sshDeploy.testConnection();
    if (!connected) {
        return {
            success: false,
            error: `Failed to connect to ${envConfig.domain}. Check SSH key and server availability.`,
        };
    }
    console.log(`  Connected`);

    // Write env file
    console.log(`  Writing .env.${stage}...`);
    const result = await sshDeploy.writeEnvFile(stage, envSecrets);
    if (!result.success) {
        return result;
    }
    console.log(`  ${result.message}`);

    // Restart container if requested
    if (options.restart) {
        const containerName = `${config.name}-${stage}`;
        console.log(`  Restarting container ${containerName}...`);
        const restartResult = await sshDeploy.restartContainer(containerName);
        if (restartResult.success) {
            console.log(`  Container restarted`);
        } else {
            console.log(`  [!] Container restart failed: ${restartResult.error}`);
            // Don't fail the whole operation for restart errors
        }
    }

    return {
        success: true,
        message: `Deployed ${Object.keys(envSecrets).length} secrets to ${stage}`,
    };
}

/**
 * Deploy secrets to staging and/or production servers
 */
export async function deploySecrets(
    environment: 'staging' | 'prod' | 'all',
    options: DeploySecretsOptions = {}
): Promise<DeploySecretsResult> {
    const rootDir = options.rootDir ?? process.cwd();

    console.log('FACTIII DEPLOY SECRETS');

    // Load configuration
    let config: FactiiiConfig;
    try {
        config = loadConfig(rootDir);
    } catch (e) {
        console.log(`\n[ERROR] ${e instanceof Error ? e.message : String(e)}`);
        return { success: false, error: String(e) };
    }

    // Check Ansible Vault configuration
    if (!config.ansible?.vault_path) {
        const error = 'ansible.vault_path not configured in config';
        console.log('\n[ERROR] ' + error);
        console.log('Add to stack.yml:');
        console.log('  ansible:');
        console.log('    vault_path: group_vars/all/vault.yml');
        console.log('    vault_password_file: ~/.vault_pass');
        return { success: false, error };
    }

    // Create vault store
    const store = new AnsibleVaultSecrets({
        vault_path: config.ansible.vault_path,
        vault_password_file: config.ansible.vault_password_file,
        rootDir,
    });

    // Get environments
    const environments = extractEnvironments(config);
    const results: { env: string; result: DeploySecretsResult }[] = [];

    // Determine which stages to deploy
    const stagesToDeploy: ('staging' | 'prod')[] =
        environment === 'all' ? ['staging', 'prod'] : [environment];

    for (const stage of stagesToDeploy) {
        // Find environment config for this stage
        const envName = Object.keys(environments).find(name => getStageType(name) === stage);
        if (!envName) {
            console.log('\n[!] No ' + stage + ' environment configured in config');
            continue;
        }

        const envConfig = environments[envName];
        if (!envConfig?.domain) {
            console.log(`\n[!] ${stage} environment missing domain configuration`);
            continue;
        }

        const result = await deployToEnvironment(stage, envConfig, config, store, options);
        results.push({ env: stage, result });

        if (!result.success) {
            console.log(`\n[ERROR] Failed to deploy to ${stage}: ${result.error}`);
        }
    }

    // Summary
    console.log('\nDEPLOYMENT SUMMARY');

    const successful = results.filter(r => r.result.success);
    const failed = results.filter(r => !r.result.success);

    for (const { env, result } of results) {
        const status = result.success ? '[OK]' : '[FAILED]';
        console.log(`  ${status} ${env}: ${result.message || result.error}`);
    }

    if (failed.length > 0) {
        return {
            success: false,
            error: `${failed.length} deployment(s) failed`,
        };
    }

    if (successful.length === 0) {
        return {
            success: true,
            message: 'No environments to deploy',
        };
    }

    return {
        success: true,
        message: `Successfully deployed to ${successful.map(s => s.env).join(', ')}`,
    };
}

export default deploySecrets;
