/**
 * SSH Deploy Helper
 *
 * Utility for deploying secrets to remote servers via SSH.
 * Used by the `factiii secrets deploy` command to write .env files
 * directly from the dev laptop to staging/prod servers.
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface SSHDeployConfig {
    host: string;
    user: string;
    privateKey: string;
    repoName: string;
}

export interface DeploySecretsResult {
    success: boolean;
    message?: string;
    error?: string;
}

/**
 * SSH Deploy - handles secure deployment of secrets to remote servers
 */
export class SSHDeploy {
    private host: string;
    private user: string;
    private privateKey: string;
    private repoName: string;
    private keyPath: string | null = null;

    constructor(config: SSHDeployConfig) {
        this.host = config.host;
        this.user = config.user;
        this.privateKey = config.privateKey;
        this.repoName = config.repoName;
    }

    /**
     * Write SSH key to temp file and return path
     */
    private setupSSHKey(): string {
        const keyPath = path.join(os.tmpdir(), `factiii-deploy-key-${Date.now()}`);

        // Ensure key ends with newline (SSH requirement)
        let key = this.privateKey;
        if (!key.endsWith('\n')) {
            key += '\n';
        }

        fs.writeFileSync(keyPath, key, { mode: 0o600 });
        this.keyPath = keyPath;
        return keyPath;
    }

    /**
     * Clean up temporary SSH key file
     */
    private cleanupSSHKey(): void {
        if (this.keyPath && fs.existsSync(this.keyPath)) {
            try {
                fs.unlinkSync(this.keyPath);
            } catch {
                // ignore cleanup errors
            }
            this.keyPath = null;
        }
    }

    /**
     * Execute SSH command
     */
    private sshExec(command: string): string {
        const keyPath = this.keyPath ?? this.setupSSHKey();

        // Build SSH command with strict options
        const sshCmd = [
            'ssh',
            '-i', `"${keyPath}"`,
            '-o', 'StrictHostKeyChecking=no',
            '-o', 'UserKnownHostsFile=/dev/null',
            '-o', 'BatchMode=yes',
            '-o', 'ConnectTimeout=30',
            `"${this.user}@${this.host}"`,
            `"${command.replace(/"/g, '\\"')}"`,
        ].join(' ');

        try {
            return execSync(sshCmd, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch (e) {
            const error = e as { stderr?: string; message?: string };
            throw new Error(`SSH command failed: ${error.stderr || error.message}`);
        }
    }

    /**
     * Test SSH connection to server
     */
    async testConnection(): Promise<boolean> {
        try {
            this.setupSSHKey();
            this.sshExec('echo "Connection test"');
            return true;
        } catch {
            return false;
        } finally {
            this.cleanupSSHKey();
        }
    }

    /**
     * Convert environment variables to .env file format
     */
    private envToFileContent(envVars: Record<string, string>): string {
        const lines: string[] = [];
        lines.push('# Environment variables - deployed by factiii secrets');
        lines.push(`# Last updated: ${new Date().toISOString()}`);
        lines.push('');

        for (const [key, value] of Object.entries(envVars)) {
            // Quote values that contain spaces, special chars, or are multi-line
            const needsQuotes = /[\s"'$`\\]/.test(value) || value.includes('\n');
            if (needsQuotes) {
                // Use double quotes and escape inner double quotes and backslashes
                const escaped = value
                    .replace(/\\/g, '\\\\')
                    .replace(/"/g, '\\"')
                    .replace(/\n/g, '\\n');
                lines.push(`${key}="${escaped}"`);
            } else {
                lines.push(`${key}=${value}`);
            }
        }

        return lines.join('\n') + '\n';
    }

    /**
     * Write .env file to server
     */
    async writeEnvFile(
        stage: 'staging' | 'prod',
        envVars: Record<string, string>
    ): Promise<DeploySecretsResult> {
        try {
            this.setupSSHKey();

            const envContent = this.envToFileContent(envVars);
            const envFileName = `.env.${stage}`;
            const factiiiDir = `$HOME/.factiii/${this.repoName}`;
            const envFilePath = `${factiiiDir}/${envFileName}`;

            // Create directory if it doesn't exist, then write the file
            // Use heredoc to safely pass content with special characters
            const escapedContent = envContent
                .replace(/\\/g, '\\\\')
                .replace(/'/g, "'\\''");

            const command = `mkdir -p ${factiiiDir} && cat > ${envFilePath} << 'FACTIII_ENV_EOF'
${envContent}FACTIII_ENV_EOF
chmod 600 ${envFilePath}`;

            this.sshExec(command);

            const keyCount = Object.keys(envVars).length;
            return {
                success: true,
                message: `Wrote ${keyCount} environment variables to ${envFilePath} on ${this.host}`,
            };
        } catch (e) {
            return {
                success: false,
                error: e instanceof Error ? e.message : String(e),
            };
        } finally {
            this.cleanupSSHKey();
        }
    }

    /**
     * Restart container on server
     */
    async restartContainer(containerName: string): Promise<DeploySecretsResult> {
        try {
            this.setupSSHKey();

            const command = `docker restart ${containerName}`;
            this.sshExec(command);

            return {
                success: true,
                message: `Restarted container ${containerName}`,
            };
        } catch (e) {
            return {
                success: false,
                error: e instanceof Error ? e.message : String(e),
            };
        } finally {
            this.cleanupSSHKey();
        }
    }

    /**
     * Check if env file exists on server
     */
    async checkEnvFileExists(stage: 'staging' | 'prod'): Promise<boolean> {
        try {
            this.setupSSHKey();

            const envFileName = `.env.${stage}`;
            const factiiiDir = `$HOME/.factiii/${this.repoName}`;
            const envFilePath = `${factiiiDir}/${envFileName}`;

            const command = `test -f ${envFilePath} && echo "exists" || echo "missing"`;
            const result = this.sshExec(command).trim();

            return result === 'exists';
        } catch {
            return false;
        } finally {
            this.cleanupSSHKey();
        }
    }

    /**
     * Get last modified time of env file on server
     */
    async getEnvFileInfo(stage: 'staging' | 'prod'): Promise<{ exists: boolean; modified?: Date }> {
        try {
            this.setupSSHKey();

            const envFileName = `.env.${stage}`;
            const factiiiDir = `$HOME/.factiii/${this.repoName}`;
            const envFilePath = `${factiiiDir}/${envFileName}`;

            // Cross-platform: macOS uses `stat -f %m`, Linux uses `stat -c %Y`
            const command = `stat -f %m ${envFilePath} 2>/dev/null || stat -c %Y ${envFilePath} 2>/dev/null || echo "missing"`;
            const result = this.sshExec(command).trim();

            if (result === 'missing') {
                return { exists: false };
            }

            const timestamp = parseInt(result, 10);
            return {
                exists: true,
                modified: new Date(timestamp * 1000),
            };
        } catch {
            return { exists: false };
        } finally {
            this.cleanupSSHKey();
        }
    }
}

export default SSHDeploy;
