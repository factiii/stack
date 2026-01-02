/**
 * Scanfix Types
 *
 * Types for the shared scanfix library.
 */

/**
 * Supported platforms for scanfix commands
 */
export type Platform = 'mac' | 'ubuntu' | 'windows';

/**
 * Platform-specific command set for a tool
 */
export interface PlatformCommands {
  /** Command to check if tool is installed */
  check: string;
  /** Command to install (undefined if manual only) */
  install?: string;
  /** Command to start (for services like Docker) */
  start?: string;
  /** Human-readable instructions for manual fix */
  manualFix: string;
}

/**
 * Tool command sets indexed by platform
 */
export type ToolCommands = Record<Platform, PlatformCommands>;
