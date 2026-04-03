/**
 * Pre-flight Validation Scanfixes
 *
 * Blocks downstream fixes when stack.yml still contains EXAMPLE_ placeholder values.
 * Must run before all other scanfixes to prevent wasted time on bad config.
 */

import type { Fix, FactiiiConfig } from '../../../../types/index.js';

/**
 * Recursively scan a parsed config object for EXAMPLE_ placeholder values.
 * Returns array of { path, value } for each placeholder found.
 */
function scanForExamples(obj: unknown, prefix: string = ''): Array<{ path: string; value: string }> {
  const results: Array<{ path: string; value: string }> = [];

  if (typeof obj === 'string' && (obj.includes('EXAMPLE_') || obj.includes('EXAMPLE-'))) {
    results.push({ path: prefix || 'root', value: obj });
  } else if (typeof obj === 'object' && obj !== null) {
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      const path = prefix ? prefix + '.' + key : key;
      results.push(...scanForExamples(value, path));
    }
  }

  return results;
}

export const preflightFixes: Fix[] = [
  {
    id: 'config-has-example-values',
    stage: 'dev',
    severity: 'critical',
    get description(): string {
      const examples = (this as any)._examples as Array<{ path: string; value: string }> | undefined;
      if (examples && examples.length > 0) {
        const shown = examples.slice(0, 3).map(e => e.path).join(', ');
        const more = examples.length > 3 ? ' (+' + (examples.length - 3) + ' more)' : '';
        return 'stack.yml contains EXAMPLE_ placeholder values: ' + shown + more;
      }
      return 'stack.yml contains EXAMPLE_ placeholder values';
    },
    scan: async function (config: FactiiiConfig): Promise<boolean> {
      const examples = scanForExamples(config);
      if (examples.length > 0) {
        (this as any)._examples = examples;
      }
      return examples.length > 0;
    },
    fix: null,
    get manualFix(): string {
      const examples = (this as any)._examples as Array<{ path: string; value: string }> | undefined;
      if (examples && examples.length > 0) {
        const lines = examples.map(e => '  ' + e.path + ': ' + e.value);
        return 'Replace these EXAMPLE_ values in stack.yml with real configuration:\n' + lines.join('\n');
      }
      return 'Replace all EXAMPLE_ values in stack.yml with real configuration';
    },
  },
];
