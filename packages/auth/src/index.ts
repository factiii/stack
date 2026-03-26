export type { AuthRouter } from './router';
export { createAuthRouter } from './router';
export type { ClientCookiePayload, CookieSettings } from './types';
export type { AuthConfig, AuthFeatures, SchemaExtensions, TokenSettings } from './types/config';
export type { ResolvedAuthConfig } from './utilities/config';
export type { AuthHooks } from './types/hooks';
export type { TrpcContext } from './types/trpc';
export {
  createAuthConfig,
  defaultAuthConfig,
  defaultCookieSettings,
  defaultStorageKeys,
  defaultTokenSettings,
} from './utilities/config';

export type { OAuthKeys, OAuthProvider, OAuthResult } from './utilities/oauth';
export { createOAuthVerifier, OAuthVerificationError } from './utilities/oauth';

export { createAuthGuard } from './middleware/authGuard';

export type { EmailAdapter } from './adapters/email';
export { createConsoleEmailAdapter, createNoopEmailAdapter } from './adapters/email';

export type {
  AuthOTP,
  AuthPasswordReset,
  AuthSession,
  AuthUser,
  CreateSessionData,
  CreateUserData,
  DatabaseAdapter,
  SessionWithDevice,
  SessionWithUser,
} from './adapters/database';
export { createPrismaAdapter } from './adapters/prismaAdapter';

export { detectBrowser, isMobileDevice, isNativeApp } from './utilities/browser';
export {
  clearAuthCookie,
  clearAuthCookies,
  DEFAULT_STORAGE_KEYS,
  parseAuthCookie,
  parseClientCookie,
  parseClientCookiePayload,
  setAuthCookie,
  setAuthCookies,
  setClientCookie,
  signClientCookie,
} from './utilities/cookies';
export {
  createAuthToken,
  decodeToken,
  isTokenExpiredError,
  isTokenInvalidError,
  verifyAuthToken,
} from './utilities/jwt';
export { comparePassword, hashPassword, validatePasswordStrength } from './utilities/password';
export type {
  CreateSessionWithTokenParams,
  SessionWithTokenResult,
} from './utilities/session';
export { createSessionWithToken, createSessionWithTokenAndCookie } from './utilities/session';
export {
  cleanBase32String,
  generateOtp,
  generateTotpCode,
  generateTotpSecret,
  verifyTotp,
} from './utilities/totp';

export type {
  ChangePasswordInput,
  LoginInput,
  OAuthLoginInput,
  ResetPasswordInput,
  SignupInput,
  TwoFaVerifyInput,
  VerifyEmailInput,
} from './validators';
export {
  biometricVerifySchema,
  changePasswordSchema,
  endAllSessionsSchema,
  loginSchema,
  oAuthLoginSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  signupSchema,
  twoFaResetSchema,
  twoFaVerifySchema,
  verifyEmailSchema,
} from './validators';

export {
  AUTH_REQUIRED_ENV_VARS,
  AUTH_OAUTH_ENV_VARS,
  AUTH_ALL_SECRET_NAMES,
  AUTH_DEFAULT_FEATURES,
  AUTH_CONFIG_SCHEMA,
  AUTH_PRISMA_MODELS,
  stackPlugin,
} from './stack-plugin';
