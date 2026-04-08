import { createNoopEmailAdapter } from '../adapters';
import type { DatabaseAdapter } from '../adapters/database';
import type { DeviceAuthAdapter } from '../adapters/deviceAuth';
import { createPrismaAdapter } from '../adapters/prismaAdapter';
import type { CookieSettings } from '../types';
import type { AuthConfig, AuthFeatures, TokenSettings } from '../types/config';

export type { AuthConfig, AuthFeatures, TokenSettings, TwoFaMode } from '../types/config';
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
 * Default feature flags
 *
 * 2FA defaults to the standard user-centric TOTP flow. Consumers wanting the
 * legacy factiii device/push-token flow must opt in via `features.twoFaMode: 'device'`
 * AND pass a `deviceAuth` adapter on `AuthConfig`.
 */
export const defaultFeatures: AuthFeatures = {
  twoFa: true,
  twoFaMode: 'standard',
  oauth: { google: true, apple: true },
  biometric: false,
  emailVerification: true,
  passwordReset: true,
  otpLogin: true,
  magicLink: false,
};

/** Resolved magic link config with defaults applied. */
export interface ResolvedMagicLinkConfig {
  siteUrl: string;
  verifyPath: string;
  defaultExpiryMs: number;
}

/** Resolved config type with database adapter guaranteed. */
export type ResolvedAuthConfig = Required<
  Omit<
    AuthConfig,
    | 'hooks'
    | 'oauthKeys'
    | 'schemaExtensions'
    | 'prisma'
    | 'getClientCookiePayload'
    | 'magicLink'
    | 'deviceAuth'
  >
> &
  AuthConfig & {
    database: DatabaseAdapter;
    deviceAuth?: DeviceAuthAdapter;
    magicLink?: ResolvedMagicLinkConfig;
  };

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

  const features = { ...defaultFeatures, ...config.features };

  // Fail fast: device-mode 2FA requires a DeviceAuthAdapter to function.
  if (features.twoFa && features.twoFaMode === 'device' && !config.deviceAuth) {
    throw new Error(
      "@factiii/auth: features.twoFaMode is 'device' but no `deviceAuth` adapter was provided. " +
        'Pass `deviceAuth: createPrismaDeviceAdapter(prisma)` (or the drizzle equivalent) ' +
        'on AuthConfig, or switch to features.twoFaMode: "standard".'
    );
  }

  return {
    ...config,
    database,
    deviceAuth: config.deviceAuth,
    features,
    tokenSettings: { ...defaultTokenSettings, ...config.tokenSettings },
    cookieSettings: { ...defaultCookieSettings, ...config.cookieSettings },
    storageKeys: { ...defaultStorageKeys, ...config.storageKeys },
    generateUsername: config.generateUsername ?? (() => `user_${Date.now()}`),
    emailService,
    magicLink: config.magicLink
      ? {
          siteUrl: config.magicLink.siteUrl,
          verifyPath: config.magicLink.verifyPath ?? '/magic-link',
          defaultExpiryMs: config.magicLink.defaultExpiryMs ?? 7 * 24 * 60 * 60 * 1000,
        }
      : undefined,
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
