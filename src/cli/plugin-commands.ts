/**
 * Plugin Commands Registration
 *
 * Discovers commands from pipeline plugins and registers them with Commander.
 * Commands follow the stage routing pattern (local vs workflow).
 */

import type { Command } from 'commander';
import type {
  PluginCommand,
  Stage,
  FactiiiConfig,
  Reachability,
  CommandCategory,
} from '../types/index.js';

/**
 * Pipeline plugin class interface for commands
 */
interface PipelinePluginClass {
  id: string;
  commands?: PluginCommand[];
  canReach(stage: Stage, config: FactiiiConfig): Reachability;
}

/**
 * Register a single command under a parent
 */
function registerCommand(
  parent: Command,
  cmd: PluginCommand,
  pipelinePlugin: PipelinePluginClass
): void {
  const subCmd = parent
    .command(cmd.name)
    .description(cmd.description)
    .option('--dev', 'Run on dev environment')
    .option('--staging', 'Run on staging environment')
    .option('--prod', 'Run on production environment');

  // Add --force flag for destructive commands
  if (cmd.prodSafety === 'destructive') {
    subCmd.option('--force', 'Force execution on production (required for destructive commands)');
  }

  // Add command-specific options
  for (const opt of cmd.options ?? []) {
    if (opt.defaultValue !== undefined) {
      subCmd.option(opt.flags, opt.description, opt.defaultValue);
    } else {
      subCmd.option(opt.flags, opt.description);
    }
  }

  // Action handler
  subCmd.action(async (options) => {
    const { executePluginCommand } = await import('./execute-plugin-command.js');
    await executePluginCommand(cmd, options, pipelinePlugin);
  });
}

/**
 * Register all commands from a pipeline plugin
 */
export function registerPluginCommands(
  program: Command,
  pipelinePlugin: PipelinePluginClass
): void {
  const commands = pipelinePlugin.commands ?? [];

  if (commands.length === 0) {
    return;
  }

  // Group commands by category
  const byCategory = new Map<CommandCategory, PluginCommand[]>();

  for (const cmd of commands) {
    const existing = byCategory.get(cmd.category) ?? [];
    existing.push(cmd);
    byCategory.set(cmd.category, existing);
  }

  // Register 'db' subcommand group
  const dbCommands = byCategory.get('db');
  if (dbCommands && dbCommands.length > 0) {
    const cmdNames = dbCommands.map(c => c.name).join(', ');
    const dbCmd = program
      .command('db')
      .description('Database operations (' + cmdNames + ')');

    for (const cmd of dbCommands) {
      registerCommand(dbCmd, cmd, pipelinePlugin);
    }
  }

  // Register 'ops' subcommand group
  const opsCommands = byCategory.get('ops');
  if (opsCommands && opsCommands.length > 0) {
    const cmdNames = opsCommands.map(c => c.name).join(', ');
    const opsCmd = program
      .command('ops')
      .description('Server operations (' + cmdNames + ')');

    for (const cmd of opsCommands) {
      registerCommand(opsCmd, cmd, pipelinePlugin);
    }
  }

  // Register 'backup' subcommand group
  const backupCommands = byCategory.get('backup');
  if (backupCommands && backupCommands.length > 0) {
    const cmdNames = backupCommands.map(c => c.name).join(', ');
    const backupCmd = program
      .command('backup')
      .description('Backup operations (' + cmdNames + ')');

    for (const cmd of backupCommands) {
      registerCommand(backupCmd, cmd, pipelinePlugin);
    }
  }
}
