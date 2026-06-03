import type { FactiiiConfig } from '../types/index.js';

/**
 * Get the per-project identifier used for multi-repo isolation.
 *
 * Unlike `getProjectName` (in aws-helpers), this does NOT fall back to 'app' —
 * unnamed repos would collide under shared namespaces like ~/.ssh/factiii/app/.
 * Throws so the caller surfaces the missing config clearly.
 */
export function getStackProjectName(config: FactiiiConfig): string {
  const name = config.name;
  if (!name || name.toUpperCase().startsWith('EXAMPLE')) {
    throw new Error(
      'Project name is required for isolation. Set `name:` in stack.yml.'
    );
  }
  return name;
}
