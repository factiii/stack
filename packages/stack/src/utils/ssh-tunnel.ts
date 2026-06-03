/**
 * SSH Tunnel (OpenSSH ControlMaster multiplexer)
 *
 * A single TCP connection + SSH handshake per stage, reused by every
 * scanfix that needs remote state. Without this, N scanfixes × ~500ms
 * of handshake overhead dominates the run.
 *
 * Lifecycle:
 *   - `openTunnel(stage, envConfig, keyPath)` starts `ssh -M -S <socket> -fN`
 *     and returns a handle. Subsequent `tunnelExec(handle, cmd)` calls add
 *     channels on the existing connection (no re-handshake).
 *   - `closeTunnel(handle)` issues `ssh -O exit` and removes the socket.
 *   - Tunnels auto-close on process exit via a best-effort `exit` handler.
 *
 * Windows: ControlMaster works on Windows 10+ with OpenSSH (built in).
 * Older Windows falls back to per-command SSH — callers must tolerate it.
 *
 * Note: this module is a pure primitive. Nothing in scan/fix/deploy calls
 * it yet. The DAG runner plus migrated scanfixes are the consumers.
 */

import { spawnSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { EnvironmentConfig } from '../types/index.js';

export interface TunnelHandle {
  socket: string;
  host: string;
  user: string;
  keyPath: string | null;
  stage: string;
}

// Process-wide cache: one tunnel per stage. Scanfixes look up their stage's
// tunnel via `getTunnel(stage)`; `runStageChain` is responsible for opening
// and closing tunnels (calling openTunnel/closeTunnel at the chain boundaries).
const tunnelsByStage = new Map<string, TunnelHandle>();
let exitHandlerRegistered = false;

function registerExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;
  const cleanup = () => {
    for (const h of tunnelsByStage.values()) {
      try { closeTunnel(h); } catch { /* best effort */ }
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
}

function socketPath(stage: string): string {
  const dir = path.join(os.homedir(), '.ssh');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Include pid so concurrent stack runs don't collide on the same socket.
  return path.join(dir, 'stack-tunnel-' + stage + '-' + process.pid + '.sock');
}

/**
 * Open a multiplexed SSH master to the stage's server. Idempotent: returns
 * the same handle if already open for this stage in this process.
 */
export function openTunnel(
  stage: string,
  envConfig: EnvironmentConfig,
  keyPath: string | null,
): TunnelHandle {
  registerExitHandler();

  const existing = tunnelsByStage.get(stage);
  if (existing) return existing;

  const host = envConfig.domain;
  const user = envConfig.ssh_user ?? 'ubuntu';
  if (!host) throw new Error('ssh-tunnel: no domain configured for ' + stage);

  const socket = socketPath(stage);
  // A leftover socket from a crashed previous run would block bind — remove it.
  try { if (fs.existsSync(socket)) fs.unlinkSync(socket); } catch { /* ignore */ }

  const args: string[] = ['-M', '-S', socket, '-fN',
    '-o', 'ControlPersist=60',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
  ];
  if (keyPath) args.push('-i', keyPath);
  args.push(user + '@' + host);

  const result = spawnSync('ssh', args, { encoding: 'utf8', stdio: 'pipe', timeout: 30000 });
  if (result.status !== 0) {
    throw new Error('ssh-tunnel open failed: ' + (result.stderr || 'exit ' + result.status));
  }

  const handle: TunnelHandle = { socket, host, user, keyPath, stage };
  tunnelsByStage.set(stage, handle);
  return handle;
}

/**
 * Look up the tunnel already opened for a stage (returns null if nothing
 * opened one yet). Scanfixes call this to acquire the shared handle rather
 * than opening their own connection; `runStageChain` opens the tunnel before
 * the fix DAG runs and closes it after.
 */
export function getTunnel(stage: string): TunnelHandle | null {
  return tunnelsByStage.get(stage) ?? null;
}

/**
 * Run a command through an open tunnel. Reuses the multiplexed connection
 * — no new handshake. Returns trimmed stdout; throws on non-zero exit.
 */
export function tunnelExec(handle: TunnelHandle, command: string): string {
  const result = spawnSync('ssh', [
    '-S', handle.socket,
    handle.user + '@' + handle.host,
    command,
  ], { encoding: 'utf8', stdio: 'pipe', timeout: 120000 });

  if (result.status !== 0) {
    throw new Error(
      'tunnel exec failed (exit ' + result.status + '): ' +
      (result.stderr || result.stdout || '').trim(),
    );
  }
  return (result.stdout ?? '').trim();
}

/**
 * Close the multiplexed master. Safe to call multiple times.
 */
export function closeTunnel(handle: TunnelHandle): void {
  const cached = tunnelsByStage.get(handle.stage);
  if (cached !== handle) return;
  tunnelsByStage.delete(handle.stage);
  try {
    execSync('ssh -S ' + JSON.stringify(handle.socket) + ' -O exit ' + handle.user + '@' + handle.host, {
      stdio: 'pipe', timeout: 5000,
    });
  } catch { /* master already gone */ }
  try { if (fs.existsSync(handle.socket)) fs.unlinkSync(handle.socket); } catch { /* ignore */ }
}

/**
 * Introspection: is the tunnel socket live?
 */
export function isTunnelAlive(handle: TunnelHandle): boolean {
  try {
    const result = spawnSync('ssh', [
      '-S', handle.socket, '-O', 'check',
      handle.user + '@' + handle.host,
    ], { stdio: 'pipe', timeout: 5000 });
    return result.status === 0;
  } catch {
    return false;
  }
}
