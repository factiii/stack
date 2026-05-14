import { type CreateHTTPContextOptions } from '@trpc/server/adapters/standalone';

import type { DeviceAuthAdapter } from './adapters/deviceAuth';
import { createAuthGuard } from './middleware/authGuard';
import { BaseProcedureFactory } from './procedures/base';
import { BiometricProcedureFactory } from './procedures/biometric';
import { EmailVerificationProcedureFactory } from './procedures/emailVerification';
import { MagicLinkProcedureFactory } from './procedures/magicLink';
import { MultiAccountProcedureFactory } from './procedures/multiAccount';
import { OAuthLoginProcedureFactory } from './procedures/oauth';
import {
  DeviceTwoFaProcedureFactory,
  StandardTwoFaProcedureFactory,
} from './procedures/twoFa';
import type { AuthFeatures, TwoFaMode } from './types/config';
import type { SchemaExtensions } from './types/hooks';
import { type AuthProcedure, type BaseProcedure, type TrpcContext } from './types/trpc';
import type { AuthConfig, ResolvedAuthConfig } from './utilities/config';
import { createAuthConfig } from './utilities/config';
import { createBaseProcedure, createTrpcBuilder, getClientIp } from './utilities/trpc';
import { createSchemas, type CreatedSchemas } from './validators';

export const createContext = ({ req, res }: CreateHTTPContextOptions): TrpcContext => ({
  headers: req.headers,
  userId: null,
  sessionId: null,
  socketId: null,
  ip: getClientIp(req),
  res,
});

/**
 * Internal scaffolding shared by both router builders. Holds the trpc
 * builder, guards, and procedure factories — but does NOT construct the
 * router itself, so each builder can do that with a literal procedure set
 * (preserving narrow inferred types per mode).
 */
class AuthScaffold<TExtensions extends SchemaExtensions = {}> {
  config: ResolvedAuthConfig;
  schemas: CreatedSchemas<TExtensions>;
  t: ReturnType<typeof createTrpcBuilder>;
  authGuard: ReturnType<typeof createAuthGuard>;
  procedure: BaseProcedure;
  authProcedure: AuthProcedure;

  constructor(userConfig: AuthConfig<TExtensions>) {
    this.config = createAuthConfig(userConfig);
    this.schemas = createSchemas<TExtensions>(userConfig.schemaExtensions);
    this.t = createTrpcBuilder(this.config);
    this.authGuard = createAuthGuard(this.config, this.t);
    this.procedure = createBaseProcedure(this.t, this.authGuard);
    this.authProcedure = this.procedure.meta({ authRequired: true });
  }

  /** Procedures common to both router modes. */
  buildSharedProcedures() {
    const baseRoutes = new BaseProcedureFactory<TExtensions>(
      this.config,
      this.procedure,
      this.authProcedure
    );
    const biometricRoutes = new BiometricProcedureFactory(this.config, this.authProcedure);
    const emailVerificationRoutes = new EmailVerificationProcedureFactory(
      this.config,
      this.authProcedure
    );
    const oAuthLoginRoutes = new OAuthLoginProcedureFactory<TExtensions>(
      this.config,
      this.procedure
    );
    const magicLinkRoutes = new MagicLinkProcedureFactory(
      this.config,
      this.procedure
    ).createMagicLinkProcedures();
    const multiAccountRoutes = new MultiAccountProcedureFactory(
      this.config,
      this.authProcedure
    ).createMultiAccountProcedures();

    return {
      base: baseRoutes.createBaseProcedures(this.schemas),
      oauth: oAuthLoginRoutes.createOAuthLoginProcedures(this.schemas),
      biometric: biometricRoutes.createBiometricProcedures(),
      emailVerification: emailVerificationRoutes.createEmailVerificationProcedures(),
      magicLink: magicLinkRoutes,
      multiAccount: multiAccountRoutes,
    };
  }
}

/** Concrete return type of a standard-mode auth router. */
export type StandardAuthRouter<TExtensions extends SchemaExtensions = {}> = ReturnType<
  typeof buildStandardAuthRouter<TExtensions>
>;

/** Concrete return type of a device-mode auth router. */
export type DeviceAuthRouter<TExtensions extends SchemaExtensions = {}> = ReturnType<
  typeof buildDeviceAuthRouter<TExtensions>
>;

/**
 * Backwards-compatible alias. Defaults to the standard auth router shape —
 * if you set `features.twoFaMode: 'device'`, use `DeviceAuthRouter` instead.
 */
export type AuthRouter<TExtensions extends SchemaExtensions = {}> = StandardAuthRouter<TExtensions>;

function buildStandardAuthRouter<TExtensions extends SchemaExtensions = {}>(
  config: AuthConfig<TExtensions>
) {
  const scaffold = new AuthScaffold<TExtensions>(config);
  const shared = scaffold.buildSharedProcedures();
  const twoFa = new StandardTwoFaProcedureFactory(
    scaffold.config,
    scaffold.procedure,
    scaffold.authProcedure
  ).createTwoFaProcedures();

  // Construct the router with a literal procedure record so the inferred
  // type stays narrow — no `Record<string, any>` widening.
  const authRouter = scaffold.t.router({
    ...shared.base,
    ...shared.oauth,
    ...twoFa,
    ...shared.biometric,
    ...shared.emailVerification,
    ...shared.magicLink,
    ...shared.multiAccount,
  });

  const router = scaffold.t.router({ auth: authRouter });

  return {
    router,
    t: scaffold.t,
    procedure: scaffold.procedure,
    authProcedure: scaffold.authProcedure,
    createContext,
  };
}

function buildDeviceAuthRouter<TExtensions extends SchemaExtensions = {}>(
  config: AuthConfig<TExtensions> & { deviceAuth: DeviceAuthAdapter }
) {
  const scaffold = new AuthScaffold<TExtensions>(config);
  if (!scaffold.config.deviceAuth) {
    throw new Error(
      "@factiii/auth: features.twoFaMode is 'device' but no `deviceAuth` adapter was provided."
    );
  }
  const shared = scaffold.buildSharedProcedures();
  const twoFa = new DeviceTwoFaProcedureFactory(
    scaffold.config,
    scaffold.config.deviceAuth,
    scaffold.procedure,
    scaffold.authProcedure
  ).createTwoFaProcedures();

  const authRouter = scaffold.t.router({
    ...shared.base,
    ...shared.oauth,
    ...twoFa,
    ...shared.biometric,
    ...shared.emailVerification,
    ...shared.magicLink,
    ...shared.multiAccount,
  });

  const router = scaffold.t.router({ auth: authRouter });

  return {
    router,
    t: scaffold.t,
    procedure: scaffold.procedure,
    authProcedure: scaffold.authProcedure,
    createContext,
  };
}

// ── Single entry point with mode-narrowed overloads ─────────────────────────
//
// `createAuthRouter(config)`:
// - With no `features.twoFaMode` (or `'standard'`) → returns StandardAuthRouter.
//   The router exposes only standard 2FA procedures
//   (enableTwofa, disableTwofa, regenerateBackupCodes,
//    twoFaReset, twoFaResetVerify). No device procedures, no SessionWithDevice
//   types leak into the consumer's tRPC client.
//
// - With `features.twoFaMode: 'device'` AND `deviceAuth` → returns DeviceAuthRouter.
//   The router exposes only device 2FA procedures
//   (enableTwofa, disableTwofa, getTwofaSecret, registerPushToken,
//    deregisterPushToken, twoFaReset, twoFaResetVerify). The standard
//   procedures are completely absent from the type surface.

/** Standard mode (default). No deviceAuth needed. */
export function createAuthRouter<TExtensions extends SchemaExtensions = {}>(
  config: AuthConfig<TExtensions> & {
    features?: AuthFeatures & { twoFaMode?: 'standard' };
    deviceAuth?: undefined;
  }
): StandardAuthRouter<TExtensions>;

/** Device mode. `deviceAuth` is required at the type level. */
export function createAuthRouter<TExtensions extends SchemaExtensions = {}>(
  config: AuthConfig<TExtensions> & {
    features: AuthFeatures & { twoFaMode: 'device' };
    deviceAuth: DeviceAuthAdapter;
  }
): DeviceAuthRouter<TExtensions>;

export function createAuthRouter<TExtensions extends SchemaExtensions = {}>(
  config: AuthConfig<TExtensions>
): StandardAuthRouter<TExtensions> | DeviceAuthRouter<TExtensions> {
  const mode: TwoFaMode = config.features?.twoFaMode ?? 'standard';
  if (mode === 'device') {
    return buildDeviceAuthRouter(
      config as AuthConfig<TExtensions> & { deviceAuth: DeviceAuthAdapter }
    );
  }
  return buildStandardAuthRouter(config);
}
