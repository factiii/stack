/**
 * Stack Plugin Contract
 *
 * Exports constants that @factiii/stack uses to manage auth deployment.
 * This is the single source of truth for what auth requires from the
 * infrastructure layer (env vars, secrets, config schema).
 *
 * Stack's auth addon imports these instead of hardcoding values.
 */

import type { AuthFeatures } from './types/config';
import { defaultFeatures } from './utilities/config';

/**
 * Environment variables that auth always requires.
 * Stack ensures these are present in vault and .env files.
 */
export const AUTH_REQUIRED_ENV_VARS = ['JWT_SECRET'] as const;

/**
 * OAuth-related environment variables, keyed by provider.
 * Stack checks these when the corresponding OAuth provider is enabled.
 */
export const AUTH_OAUTH_ENV_VARS = {
  google: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] as const,
  apple: ['APPLE_CLIENT_ID'] as const,
} as const;

/**
 * All possible auth-related secret names (for vault management).
 */
export const AUTH_ALL_SECRET_NAMES = [
  ...AUTH_REQUIRED_ENV_VARS,
  ...AUTH_OAUTH_ENV_VARS.google,
  ...AUTH_OAUTH_ENV_VARS.apple,
] as const;

/**
 * Default feature flags — re-exported from config for stack to use
 * when generating config schemas.
 */
export { defaultFeatures as AUTH_DEFAULT_FEATURES } from './utilities/config';

/**
 * The AuthFeatures type — re-exported for stack's config schema.
 */
export type { AuthFeatures } from './types/config';

/**
 * Config schema for stack.yml — describes the auth section
 * that users can configure. Derived from AuthFeatures defaults.
 */
export const AUTH_CONFIG_SCHEMA = {
  auth: {
    features: {
      oauth: false,
      twoFa: (defaultFeatures as AuthFeatures).twoFa ?? false,
      emailVerification: (defaultFeatures as AuthFeatures).emailVerification ?? false,
      biometric: (defaultFeatures as AuthFeatures).biometric ?? false,
      passwordReset: (defaultFeatures as AuthFeatures).passwordReset ?? false,
      otpLogin: (defaultFeatures as AuthFeatures).otpLogin ?? false,
      magicLink: (defaultFeatures as AuthFeatures).magicLink ?? false,
    },
    oauth_provider: 'EXAMPLE_google',
  },
} as const;

/**
 * Prisma model names that auth requires.
 * Stack checks for these in the Prisma schema to detect auth initialization.
 */
export const AUTH_PRISMA_MODELS = ['User', 'Session'] as const;

/**
 * The stackPlugin export that @factiii/stack looks for.
 * Currently exports the config contract. When auth needs to provide
 * its own Fix implementations, they'll be added here.
 */
export const stackPlugin = {
  requiredEnvVars: AUTH_REQUIRED_ENV_VARS,
  oauthEnvVars: AUTH_OAUTH_ENV_VARS,
  allSecretNames: AUTH_ALL_SECRET_NAMES,
  configSchema: AUTH_CONFIG_SCHEMA,
  prismaModels: AUTH_PRISMA_MODELS,
};
