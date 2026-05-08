/**
 * Server GitHub Access Scanfix (staging only)
 *
 * Staging clones the repo on the deploy target to build the image from source
 * (see FactiiiPipeline.requiresFullRepo). That requires:
 *   1. github.com in the server's ~/.ssh/known_hosts
 *   2. an SSH key on the server (we use ~/.ssh/id_ed25519) whose pubkey is
 *      authorized as a deploy key on the GitHub repo (or as an account key)
 *
 * Prod is intentionally NOT covered — prod pulls pre-built images from ECR
 * and never touches GitHub from the server.
 *
 * The fix is partly interactive: we can install the host key + generate the
 * server key automatically, but registering the deploy key with GitHub is on
 * the user. We surface the pubkey and pause until they confirm.
 */
import { spawnSync } from 'child_process';

import type { FactiiiConfig, EnvironmentConfig, Fix } from '../../../../types/index.js';
import { extractEnvironments, hasEnvironments } from '../../../../utils/config-helpers.js';
import { findSshKeyForStage } from '../../../../utils/ssh-helper.js';

type TargetStage = 'staging';

interface SshTarget {
  user: string;
  host: string;
  keyPath: string;
}

function resolveSshTarget(
  config: FactiiiConfig,
  targetStage: TargetStage
): SshTarget | null {
  if (!hasEnvironments(config)) return null;
  const envs = extractEnvironments(config);
  const entry = Object.entries(envs).find(
    ([name]) => name === targetStage || name.startsWith(targetStage + '_')
  );
  if (!entry) return null;
  const envConfig = entry[1] as EnvironmentConfig | undefined;
  const host = envConfig?.domain;
  if (!host || host.toUpperCase().startsWith('EXAMPLE')) return null;

  const keyPath = findSshKeyForStage(targetStage, config.name);
  if (!keyPath) return null;

  return {
    user: envConfig?.ssh_user ?? 'ubuntu',
    host,
    keyPath,
  };
}

function runOnServer(target: SshTarget, command: string, timeoutMs = 15000) {
  return spawnSync(
    'ssh',
    [
      '-i', target.keyPath,
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ConnectTimeout=5',
      target.user + '@' + target.host,
      command,
    ],
    { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs }
  );
}

/**
 * GitHub returns exit 1 with a "successfully authenticated" line when an SSH
 * key is recognized, even though it refuses shell access. We grep stderr+stdout
 * for that line rather than relying on exit code.
 */
function gitHubAuthSucceeded(stdout: string, stderr: string): boolean {
  const blob = (stdout ?? '') + '\n' + (stderr ?? '');
  return /successfully authenticated/i.test(blob);
}

function shouldSkip(): boolean {
  if (process.env.GITHUB_ACTIONS === 'true') return true;
  if (process.env.FACTIII_ON_SERVER === 'true') return true;
  return false;
}

function makeServerGithubAccessFix(targetStage: TargetStage): Fix {
  return {
    id: 'server-github-access-' + targetStage,
    stage: 'dev',
    targetStage,
    severity: 'critical',
    description:
      '🔑 ' + targetStage + ' server cannot authenticate to github.com (needed to clone the repo)',
    scan: async (config: FactiiiConfig): Promise<boolean> => {
      if (shouldSkip()) return false;

      const target = resolveSshTarget(config, targetStage);
      if (!target) return false; // not enough config to test — let other fixes complain

      // Quick reachability probe — if SSH itself fails, ssh-verify-* will report it.
      const probe = runOnServer(target, 'echo ok', 8000);
      if (probe.status !== 0) return false;

      // Run `ssh -T git@github.com` on the server, with BatchMode so it can't
      // hang waiting for known_hosts confirmation. StrictHostKeyChecking is
      // left at the user/server default (usually 'ask') so a missing host key
      // surfaces as a failure rather than silent acceptance.
      const probeGit = runOnServer(
        target,
        'ssh -T -o BatchMode=yes -o ConnectTimeout=5 git@github.com 2>&1 || true',
        20000
      );
      const out = probeGit.stdout ?? '';
      const err = probeGit.stderr ?? '';
      return !gitHubAuthSucceeded(out, err);
    },
    fix: async (config: FactiiiConfig): Promise<boolean> => {
      const target = resolveSshTarget(config, targetStage);
      if (!target) {
        console.log('   [!] Cannot resolve ' + targetStage + ' SSH target — skipping');
        return false;
      }

      console.log('   Setting up GitHub access on ' + target.user + '@' + target.host + '...');

      // Step 1 — pin github.com host keys so future ssh/git invocations don't
      // get blocked on prompts. Append-and-dedupe is idempotent across re-runs.
      const ensureHostKey = [
        'mkdir -p ~/.ssh',
        'chmod 700 ~/.ssh',
        'touch ~/.ssh/known_hosts',
        'ssh-keyscan -t rsa,ecdsa,ed25519 github.com 2>/dev/null >> ~/.ssh/known_hosts',
        'sort -u -o ~/.ssh/known_hosts ~/.ssh/known_hosts',
      ].join(' && ');
      const hostKeyResult = runOnServer(target, ensureHostKey, 20000);
      if (hostKeyResult.status !== 0) {
        console.log('   [!] Failed to update server known_hosts: ' + (hostKeyResult.stderr ?? '').trim());
        return false;
      }
      console.log('   [OK] github.com pinned in server known_hosts');

      // Step 2 — ensure a key exists at ~/.ssh/id_ed25519 on the server.
      // Generate one if it isn't there (passphrase-less, like the deploy key).
      const ensureKey = [
        'if [ ! -f ~/.ssh/id_ed25519 ]; then',
        '  ssh-keygen -t ed25519 -N "" -C "factiii-' + targetStage + '-deploy@$(hostname)" -f ~/.ssh/id_ed25519 >/dev/null;',
        '  echo CREATED;',
        'else',
        '  echo EXISTS;',
        'fi',
      ].join(' ');
      const keyResult = runOnServer(target, ensureKey, 20000);
      if (keyResult.status !== 0) {
        console.log('   [!] Failed to ensure server SSH key: ' + (keyResult.stderr ?? '').trim());
        return false;
      }
      const created = (keyResult.stdout ?? '').includes('CREATED');
      console.log(created
        ? '   [OK] Generated ~/.ssh/id_ed25519 on server'
        : '   [OK] Server already has ~/.ssh/id_ed25519');

      // Step 3 — fetch the pubkey, show it, and ask the user to register it
      // with GitHub. We can't do this for them without a GitHub PAT.
      const pubkeyResult = runOnServer(target, 'cat ~/.ssh/id_ed25519.pub', 10000);
      if (pubkeyResult.status !== 0) {
        console.log('   [!] Could not read ~/.ssh/id_ed25519.pub on server');
        return false;
      }
      const pubkey = (pubkeyResult.stdout ?? '').trim();

      console.log('');
      console.log('   ============================================================');
      console.log('   GITHUB DEPLOY KEY REQUIRED');
      console.log('   ============================================================');
      console.log('   Add this public key as a deploy key on your GitHub repo');
      const repo = config.github_repo;
      if (repo && !repo.toUpperCase().startsWith('EXAMPLE')) {
        console.log('   (https://github.com/' + repo + '/settings/keys/new)');
      }
      console.log('   — read-only is fine for cloning.');
      console.log('');
      console.log('   ' + pubkey);
      console.log('');
      console.log('   ============================================================');

      // Step 4 — prompt the user to confirm they've added it, then re-test.
      // We dynamic-import to keep this scanfix free of top-level deps on the
      // prompt module (matches the pattern used in iam.ts).
      const { confirm } = await import('../../../../utils/secret-prompts.js');
      const proceed = await confirm(
        '   Press y once the deploy key has been added to GitHub',
        true
      );
      if (!proceed) {
        console.log('   [--] Skipped — deploy will fail at clone until this is resolved');
        return false;
      }

      const verify = runOnServer(
        target,
        'ssh -T -o BatchMode=yes -o ConnectTimeout=5 git@github.com 2>&1 || true',
        20000
      );
      if (gitHubAuthSucceeded(verify.stdout ?? '', verify.stderr ?? '')) {
        console.log('   [OK] Server authenticated to github.com');
        return true;
      }

      console.log('   [!] github.com still rejects the key — double-check it was added to ' +
        (repo && !repo.toUpperCase().startsWith('EXAMPLE')
          ? 'github.com/' + repo + '/settings/keys'
          : 'the repo deploy keys'));
      return false;
    },
    manualFix:
      'On the ' + targetStage + ' server: ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519 -N "" && ' +
      'ssh-keyscan github.com >> ~/.ssh/known_hosts. Then add the contents of ~/.ssh/id_ed25519.pub ' +
      'as a deploy key in your GitHub repo (Settings → Deploy keys).',
  };
}

export const serverGithubAccessFixes: Fix[] = [
  makeServerGithubAccessFix('staging'),
];
