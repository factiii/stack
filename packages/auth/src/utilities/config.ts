import { createNoopEmailAdapter } from '../adapters';
import type { DatabaseAdapter } from '../adapters/database';
import { createPrismaAdapter } from '../adapters/prismaAdapter';
import type { CookieSettings } from '../types';
import type { AuthConfig, AuthFeatures, TokenSettings } from '../types/config';

export type { AuthConfig, AuthFeatures, TokenSettings } from '../types/config';
export type { OAuthKeys } from './oauth';

/**
 * Default token settings
 */
export const defaultTokenSettings: TokenSettings = {
  jwtExpiry: 365 * 24 * 60 * 60, // 1 year in seconds
  passwordResetExpiryMs: 60 * 60 * 1000, // 1 hour
  otpValidityMs: 15 * 60 * 1000, // 15 minutes
};

/**
 * Default cookie settings
 */
export const defaultCookieSettings: CookieSettings = {
  secure: true,
  sameSite: 'Strict',
  httpOnly: true,
  path: '/',
  maxAge: 365 * 24 * 60 * 60, // 1 year in seconds (matches jwtExpiry)
};

/**
 * Default storage keys
 */
export const defaultStorageKeys = {
  authToken: 'auth-token',
  clientToken: 'auth-client',
};

/**
 * Default feature flags (all optional features disabled)
 */
export const defaultFeatures: AuthFeatures = {
  twoFa: true,
  twoFaRequiresDevice: true,
  oauth: { google: true, apple: true },
  biometric: false,
  emailVerification: true,
  passwordReset: true,
  otpLogin: true,
};

/** Resolved config type with database adapter guaranteed. */
export type ResolvedAuthConfig = Required<
  Omit<AuthConfig, 'hooks' | 'oauthKeys' | 'schemaExtensions' | 'prisma' | 'getClientCookiePayload'>
> &
  AuthConfig & { database: DatabaseAdapter };

/**
 * Create a fully resolved auth config with defaults applied.
 * Accepts either `database` (adapter) or `prisma` (auto-wrapped).
 */
export function createAuthConfig(config: AuthConfig): ResolvedAuthConfig {
  if (!config.database && !config.prisma) {
    throw new Error(
      '@factiii/auth: Provide either a `database` adapter or a `prisma` client in config.'
    );
  }

  const database =
    config.database ??
    createPrismaAdapter(config.prisma);

  const emailService = config.emailService ?? createNoopEmailAdapter();

  return {
    ...config,
    database,
    features: { ...defaultFeatures, ...config.features },
    tokenSettings: { ...defaultTokenSettings, ...config.tokenSettings },
    cookieSettings: { ...defaultCookieSettings, ...config.cookieSettings },
    storageKeys: { ...defaultStorageKeys, ...config.storageKeys },
    generateUsername: config.generateUsername ?? (() => `user_${Date.now()}`),
    emailService,
  };
}

/**
 * Default auth config (requires database/prisma and secrets to be provided)
 */
export const defaultAuthConfig = {
  features: defaultFeatures,
  tokenSettings: defaultTokenSettings,
  cookieSettings: defaultCookieSettings,
  storageKeys: defaultStorageKeys,
};
