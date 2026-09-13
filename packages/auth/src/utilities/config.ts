import { createNoopEmailAdapter } from '../adapters';
import type { DatabaseAdapter } from '../adapters/database';
import type { DeviceAuthAdapter } from '../adapters/deviceAuth';
import type { LoginEmailParams } from '../adapters/email';
import type { OAuthAccountAdapter } from '../adapters/oauthAccount';
import type { PasskeyAdapter } from '../adapters/passkey';
import { createPrismaAdapter } from '../adapters/prismaAdapter';
import type { CookieSettings } from '../types';
import type {
  AuthConfig,
  AuthFeatures,
  EmailLoginAppConfig,
  TokenSettings,
} from '../types/config';

export type {
  AuthConfig,
  AuthFeatures,
  EmailLoginAppConfig,
  EmailLoginConfig,
  TokenSettings,
  TwoFaMode,
} from '../types/config';
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
  emailLogin: false,
};

/** Resolved magic link config with defaults applied. */
export interface ResolvedMagicLinkConfig {
  siteUrl: string;
  verifyPath: string;
  defaultExpiryMs: number;
}

/** Resolved email login config: defaults applied, every requirement checked. */
export interface ResolvedEmailLoginConfig {
  apps: Record<string, EmailLoginAppConfig>;
  pepper: string;
  rateLimit: (key: string, max: number, windowSec: number) => Promise<boolean>;
  sendLoginEmail: (params: LoginEmailParams) => Promise<void>;
  ttlMs: number;
  responseFloorMs: number;
}

/** An HMAC key shorter than this is within reach of an offline guess. */
const MIN_EMAIL_LOGIN_PEPPER_LENGTH = 32;
const DEFAULT_EMAIL_LOGIN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_EMAIL_LOGIN_RESPONSE_FLOOR_MS = 400;

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
    | 'emailLogin'
    | 'deviceAuth'
    | 'passkey'
    | 'oauthAccounts'
    | 'maxAccounts'
    | 'webauthn'
  >
> &
  AuthConfig & {
    database: DatabaseAdapter;
    deviceAuth?: DeviceAuthAdapter;
    passkey?: PasskeyAdapter;
    oauthAccounts?: OAuthAccountAdapter;
    magicLink?: ResolvedMagicLinkConfig;
    emailLogin?: ResolvedEmailLoginConfig;
    maxAccounts: number;
  };

/**
 * Check every piece email sign-in needs before the server takes a request. A
 * missing pepper or rate limiter is not a degraded mode — it is an open door —
 * so the answer to each one is to refuse to start.
 */
function resolveEmailLogin(
  config: AuthConfig,
  database: DatabaseAdapter
): ResolvedEmailLoginConfig {
  const refuse = (what: string) =>
    new Error(`@factiii/auth: features.emailLogin is on, but ${what}.`);

  const settings = config.emailLogin;
  if (!settings) {
    throw refuse('no `emailLogin` config was provided');
  }

  const apps = Object.entries(settings.apps ?? {});
  if (apps.length === 0) {
    throw refuse('`emailLogin.apps` lists no app');
  }
  for (const [key, app] of apps) {
    if (!URL.canParse(app.siteUrl)) {
      throw refuse(`\`emailLogin.apps.${key}.siteUrl\` is not a URL`);
    }
  }

  if (!settings.pepper || settings.pepper.length < MIN_EMAIL_LOGIN_PEPPER_LENGTH) {
    throw refuse(
      `\`emailLogin.pepper\` is missing or shorter than ${MIN_EMAIL_LOGIN_PEPPER_LENGTH} characters`
    );
  }

  if (typeof settings.rateLimit !== 'function') {
    throw refuse('no `emailLogin.rateLimit` was provided');
  }

  const emailService = config.emailService;
  const sendLoginEmail = emailService?.sendLoginEmail;
  if (!emailService || !sendLoginEmail) {
    throw refuse('`emailService.sendLoginEmail` is not implemented');
  }

  if (!database.emailLoginAttempt) {
    throw refuse(
      'the database adapter has no `emailLoginAttempt` store — add the EmailLoginAttempt model'
    );
  }

  return {
    apps: settings.apps,
    pepper: settings.pepper,
    rateLimit: settings.rateLimit,
    sendLoginEmail: sendLoginEmail.bind(emailService),
    ttlMs: settings.ttlMs ?? DEFAULT_EMAIL_LOGIN_TTL_MS,
    responseFloorMs: settings.responseFloorMs ?? DEFAULT_EMAIL_LOGIN_RESPONSE_FLOOR_MS,
  };
}

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

  const database = config.database ?? createPrismaAdapter(config.prisma);

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

  // Fail fast too: resolved against the consumer's own emailService, not the
  // no-op default, so a missing sender cannot quietly swallow sign-in emails.
  const emailLogin = features.emailLogin ? resolveEmailLogin(config, database) : undefined;

  return {
    ...config,
    database,
    deviceAuth: config.deviceAuth,
    passkey: config.passkey,
    oauthAccounts: config.oauthAccounts,
    features,
    tokenSettings: { ...defaultTokenSettings, ...config.tokenSettings },
    cookieSettings: { ...defaultCookieSettings, ...config.cookieSettings },
    storageKeys: { ...defaultStorageKeys, ...config.storageKeys },
    // The random tail keeps two accounts made in one millisecond, or a retry after
    // a taken name, from drawing the same username.
    generateUsername:
      config.generateUsername ??
      (() =>
        `user_${Date.now()}${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`),
    emailService,
    magicLink: config.magicLink
      ? {
          siteUrl: config.magicLink.siteUrl,
          verifyPath: config.magicLink.verifyPath ?? '/magic-link',
          defaultExpiryMs: config.magicLink.defaultExpiryMs ?? 7 * 24 * 60 * 60 * 1000,
        }
      : undefined,
    emailLogin,
    maxAccounts: config.maxAccounts ?? 1,
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
