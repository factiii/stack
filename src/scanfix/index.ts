/**
 * Scanfix Library
 *
 * Shared, platform-aware scanfixes that plugins can import.
 *
 * Usage:
 * ```typescript
 * import { getDockerFixes, getNodeFixes, createCertbotFix } from '../../scanfix/index.js';
 *
 * static readonly fixes: Fix[] = [
 *   ...getDockerFixes('dev'),
 *   ...getDockerFixes('staging'),
 *   ...getNodeFixes('staging'),
 *   createCertbotFix('staging', 'staging'),
 * ];
 * ```
 */

// Types
export * from './types.js';

// Platform detection
export * from './platform.js';

// SSL certificate helpers
export * from './ssl-cert-helper.js';

// Commands
export * from './commands/index.js';

// Fix factories
export * from './fixes/index.js';
