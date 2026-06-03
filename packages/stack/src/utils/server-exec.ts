/**
 * serverExec — single routing primitive for shell commands issued by scanfixes.
 *
 * Usage from a scanfix:
 *   import { serverExec } from '../../utils/server-exec.js';
 *   const out = serverExec(stage, 'docker ps -q -f name=' + name);
 *
 * Routing:
 *   - stage === 'dev'              → local execSync
 *   - stage === 'staging' | 'prod' → tunnelExec via the per-stage tunnel
 *                                    handle cached in ssh-tunnel.ts. Throws
 *                                    if no tunnel is cached (in practice
 *                                    impossible because runStageChain opens
 *                                    the tunnel on stage entry).
 *
 * Returns trimmed stdout. Throws on non-zero exit (both paths).
 */

import { execSync } from 'child_process';
import { getTunnel, tunnelExec } from './ssh-tunnel.js';
import type { Stage } from '../types/index.js';

export function serverExec(stage: Stage, cmd: string): string {
  if (stage === 'dev') {
    const buf = execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return buf.toString().trim();
  }

  // staging or prod — must have an open tunnel
  const handle = getTunnel(stage);
  if (!handle) {
    throw new Error(
      'serverExec: no tunnel open for ' + stage +
      '. runStageChain is responsible for opening tunnels on stage entry. ' +
      'If you reached this from a unit test, mock openTunnel/getTunnel.',
    );
  }
  return tunnelExec(handle, cmd);
}
