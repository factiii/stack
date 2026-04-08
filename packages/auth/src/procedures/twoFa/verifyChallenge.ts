/**
 * Login-time 2FA challenge dispatcher.
 *
 * Called from `procedures/base.ts` after a successful password check, when
 * the user has 2FA enabled. Routes to the standard or device verifier based
 * on `config.features.twoFaMode`.
 */
import type { AuthUser } from '../../adapters/database';
import type { ResolvedAuthConfig } from '../../utilities/config';
import { verifyDeviceTwoFa } from './device';
import { verifyStandardTwoFa } from './standard';

/**
 * Mode-aware "is 2FA active for this user?" check.
 *
 * Standard mode derives this from `User.twoFaSecret` (single source of truth —
 * no separate boolean column). Device mode reads `User.twoFaEnabled` because
 * the secret material lives on `Session`, not `User`, and sessions are
 * ephemeral.
 */
export function isTwoFaEnabled(config: ResolvedAuthConfig, user: AuthUser): boolean {
  if (config.features.twoFaMode === 'device') {
    return Boolean(user.twoFaEnabled);
  }
  return user.twoFaSecret != null;
}

export async function verifyTwoFaChallenge(
  config: ResolvedAuthConfig,
  user: AuthUser,
  code: string
): Promise<boolean> {
  if (config.features.twoFaMode === 'device') {
    if (!config.deviceAuth) {
      // createAuthConfig already fails fast on this misconfiguration; the
      // check here is a safety net for direct ResolvedAuthConfig consumers.
      throw new Error("twoFaMode 'device' requires a deviceAuth adapter");
    }
    return verifyDeviceTwoFa(config, config.deviceAuth, user, code);
  }
  return verifyStandardTwoFa(config, user, code);
}
