/**
 * OpenClaw Addon
 *
 * Automates the setup of OpenClaw (autonomous AI agent) running inside
 * a Tart VM on macOS with a local LLM via Ollama.
 *
 * ============================================================
 * USAGE
 * ============================================================
 *
 * Enable in stack.yml (shared across team):
 *
 * openclaw:
 *   model: qwen2.5-coder:7b    # Ollama model (must support tool calling)
 *
 * Or in stack.local.yml (per-developer, gitignored):
 *
 * openclaw:
 *   model: qwen2.5-coder:7b
 *
 * Then run:
 *   npx stack scan --dev    # See what's missing
 *   npx stack fix --dev     # Install Tart, Ollama, model, OpenClaw
 * ============================================================
 */

import type { FactiiiConfig, Fix } from '../../../types/index.js';

// Import scanfix array
import { openclawFixes } from './scanfix/setup.js';

class OpenClawAddon {
  // ============================================================
  // STATIC METADATA
  // ============================================================

  static readonly id = 'openclaw';
  static readonly name = 'OpenClaw';
  static readonly category: 'addon' = 'addon';
  static readonly version = '1.0.0';

  static readonly requiredEnvVars: string[] = [];

  static readonly configSchema: Record<string, unknown> = {
    // openclaw.model - Ollama model name (must support tool calling)
  };

  static readonly autoConfigSchema: Record<string, string> = {};

  /**
   * Determine if this addon should be loaded.
   * Loads if openclaw config exists in stack.yml or stack.local.yml.
   */
  static async shouldLoad(_rootDir: string, config: FactiiiConfig): Promise<boolean> {
    if ((config as Record<string, unknown>).openclaw) return true;

    try {
      const { loadLocalConfig } = await import('../../../utils/config-helpers.js');
      const localConfig = loadLocalConfig(_rootDir);
      return !!(localConfig as Record<string, unknown>).openclaw;
    } catch {
      return false;
    }
  }

  // ============================================================
  // FIXES - All issues this addon can detect and resolve
  // ============================================================

  static readonly fixes: Fix[] = [
    ...openclawFixes,
  ];

  // ============================================================
  // INSTANCE METHODS
  // ============================================================

  private _config: FactiiiConfig;

  constructor(config: FactiiiConfig) {
    this._config = config;
  }
}

export default OpenClawAddon;
