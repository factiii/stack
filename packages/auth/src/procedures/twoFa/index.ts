/**
 * 2FA procedures dispatcher.
 *
 * Returns one of two disjoint procedure sets based on `features.twoFaMode`:
 *
 * - `'standard'` (default): user-centric TOTP + backup codes. Procedures:
 *   `enableTwofa`, `confirmEnableTwofa`, `disableTwofa`,
 *   `regenerateBackupCodes`, `twoFaReset`, `twoFaResetVerify`.
 *
 * - `'device'`: legacy factiii mobile-bound flow. Procedures:
 *   `enableTwofa`, `disableTwofa`, `getTwofaSecret`, `registerPushToken`,
 *   `deregisterPushToken`, `twoFaReset`, `twoFaResetVerify`.
 *
 * The two procedure sets are intentionally disjoint — a standard-mode
 * router never exposes `getTwofaSecret`, and a device-mode router never
 * exposes `confirmEnableTwofa`/`regenerateBackupCodes`.
 */
import { type AuthProcedure, type BaseProcedure } from '../../types/trpc';
import type { ResolvedAuthConfig } from '../../utilities/config';
import { DeviceTwoFaProcedureFactory } from './device';
import { StandardTwoFaProcedureFactory } from './standard';

export { verifyTwoFaChallenge } from './verifyChallenge';
export { StandardTwoFaProcedureFactory, verifyStandardTwoFa } from './standard';
export { DeviceTwoFaProcedureFactory, verifyDeviceTwoFa } from './device';

/**
 * Build the 2FA procedure record for the configured mode.
 *
 * Called by `router.ts` and spread into the auth router. Throws at startup
 * if device mode is requested without a `deviceAuth` adapter (`createAuthConfig`
 * already validates this — the check here is for direct ResolvedAuthConfig use).
 */
export function createTwoFaProcedures(
  config: ResolvedAuthConfig,
  procedure: BaseProcedure,
  authProcedure: AuthProcedure
) {
  if (config.features.twoFaMode === 'device') {
    if (!config.deviceAuth) {
      throw new Error(
        "@factiii/auth: features.twoFaMode is 'device' but no `deviceAuth` adapter was provided."
      );
    }
    return new DeviceTwoFaProcedureFactory(
      config,
      config.deviceAuth,
      procedure,
      authProcedure
    ).createTwoFaProcedures();
  }
  return new StandardTwoFaProcedureFactory(
    config,
    procedure,
    authProcedure
  ).createTwoFaProcedures();
}
