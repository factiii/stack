/**
 * SSH Tunnel Scanfixes
 *
 * The single "open one SSH tunnel per stage" scanfix for staging and prod.
 * Every other staging/prod scanfix that needs to touch remote state
 * implicitly depends on the corresponding `ssh-tunnel-<stage>` fix — the
 * stage-chain runner injects that `requires` edge automatically, so
 * individual scanfixes never hand-write it.
 *
 * Design notes:
 *   - Runs on the dev machine, SSHes out. Skips on-server runs (they don't
 *     need a tunnel to themselves).
 *   - The fix function is the one that actually calls `openTunnel`. That's
 *     a bit unusual for a "fix" — it's opening a long-lived resource, not
 *     editing config — but it fits the "scan detected the desired state
 *     (a live tunnel) is missing; fix establishes it" shape cleanly.
 *   - `ssh-tunnel-staging` requires dev + secrets to already be clean
 *     (the stage-chain runner guarantees that by stage ordering, so this
 *     scanfix has no explicit `requires`). Same for prod.
 *   - Existing `ssh-verify-<stage>` in ssh-verify.ts is kept for now — it's
 *     a one-shot probe with no lifecycle. Once every staging/prod scanfix
 *     uses `tunnelExec`, ssh-verify becomes redundant and can be retired.
 */

import type { EnvironmentConfig, FactiiiConfig, Fix } from '../../../../types/index.js';
import { extractEnvironments, hasEnvironments } from '../../../../utils/config-helpers.js';
import { findSshKeyForStage } from '../../../../utils/ssh-helper.js';
import { openTunnel, getTunnel, isTunnelAlive } from '../../../../utils/ssh-tunnel.js';

function onServer(): boolean {
  return process.env.FACTIII_ON_SERVER === 'true' || process.env.GITHUB_ACTIONS === 'true';
}

function stageEnvConfig(
  config: FactiiiConfig,
  stage: 'staging' | 'prod',
): EnvironmentConfig | null {
  if (!hasEnvironments(config)) return null;
  const envs = extractEnvironments(config);
  const match = Object.entries(envs).find(
    ([name]) => name === stage || name.startsWith(stage + '_'),
  );
  if (!match) return null;
  const env = match[1];
  if (!env.domain || env.domain.toUpperCase().startsWith('EXAMPLE')) return null;
  return env;
}

function makeTunnelFix(stage: 'staging' | 'prod'): Fix {
  const id = 'ssh-tunnel-' + stage;
  return {
    id,
    stage,
    severity: 'critical',
    description: '🔒 Open SSH tunnel to ' + stage + ' (shared by all ' + stage + ' scanfixes)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      // On the server itself there's nothing to tunnel to — and nothing to do.
      if (onServer()) return false;

      // No configured environment for this stage → nothing to tunnel to.
      if (!stageEnvConfig(config, stage)) return false;

      // Issue exists iff the tunnel isn't open, or the socket went stale.
      const existing = getTunnel(stage);
      if (!existing) return true;
      return !isTunnelAlive(existing);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      if (onServer()) return true;
      const envConfig = stageEnvConfig(config, stage);
      if (!envConfig) return false;

      const keyPath = findSshKeyForStage(stage, config.name);
      if (!keyPath) {
        // No key means the secrets stage didn't finish, or no vault key was
        // ever stored. Fail clearly; the stage-chain runner marks the rest
        // of this stage `skipped` with "prereq ssh-tunnel-<stage> failed".
        return false;
      }

      try {
        openTunnel(stage, envConfig, keyPath);
        return true;
      } catch {
        return false;
      }
    },
    manualFix:
      'Verify ~/.ssh/' + stage + '_deploy_key exists and works:\n' +
      '     ssh -i ~/.ssh/' + stage + '_deploy_key <ssh_user>@<' + stage + '-domain> echo ok\n' +
      '   If the key is in Ansible Vault but not on disk, run:\n' +
      '     npx stack deploy --secrets write-ssh-keys',
  };
}

export const sshTunnelFixes: Fix[] = [
  makeTunnelFix('staging'),
  makeTunnelFix('prod'),
];
