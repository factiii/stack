/**
 * Mode-agnostic 2FA procedures: email-based reset request and verification.
 *
 * Both `standard` and `device` modes expose these procedures unchanged.
 * They live here so neither mode-specific factory has to duplicate them.
 */
import { TRPCError } from '@trpc/server';

import { type BaseProcedure } from '../../types/trpc';
import type { ResolvedAuthConfig } from '../../utilities/config';
import { comparePassword } from '../../utilities/password';
import { generateOtp } from '../../utilities/totp';
import {
  twoFaResetSchema,
  twoFaResetVerifySchema,
} from '../../validators/twoFa.shared';
import { isTwoFaEnabled } from './verifyChallenge';

/**
 * Build the `twoFaReset` procedure: re-authenticates the user with
 * username + password, then emails them a 6-digit OTP they can use
 * to disable 2FA via `twoFaResetVerify`.
 *
 * The `clearOnVerify` callback owns ALL mode-specific teardown:
 *   Standard mode: clears `User.twoFaSecret` + backup codes.
 *   Device mode:   clears all `Session.twoFaSecret` rows AND flips
 *                  `User.twoFaEnabled` to false.
 *
 * Keeping every "is 2FA on?" / "turn 2FA off" decision out of this file
 * means shared.ts never has to know which mode it's running under.
 */
export function buildTwoFaResetProcedures(
  config: ResolvedAuthConfig,
  procedure: BaseProcedure,
  clearOnVerify: (userId: number) => Promise<void>
) {
  const checkConfig = () => {
    if (!config.features.twoFa) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
  };

  const twoFaReset = procedure.input(twoFaResetSchema).mutation(async ({ input }) => {
    checkConfig();
    const { username, password } = input;

    const user = await config.database.user.findByEmailOrUsernameInsensitive(username);

    if (!user || !isTwoFaEnabled(config, user)) {
      throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Invalid credentials.' });
    }

    if (!user.password) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'Social login accounts cannot use 2FA reset.',
      });
    }

    const isMatch = await comparePassword(password, user.password);
    if (!isMatch) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid credentials.' });
    }

    const otp = generateOtp();
    const expiresAt = new Date(Date.now() + config.tokenSettings.otpValidityMs);

    await config.database.otp.create({ userId: user.id, code: otp, expiresAt });

    if (config.emailService) {
      await config.emailService.sendOTPEmail(user.email, otp);
    }

    return { success: true };
  });

  const twoFaResetVerify = procedure
    .input(twoFaResetVerifySchema)
    .mutation(async ({ input }) => {
      checkConfig();
      const { code, username } = input;

      const user = await config.database.user.findByEmailOrUsernameInsensitive(username);

      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const otp = await config.database.otp.findValidByUserAndCode(user.id, code);

      if (!otp) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid or expired OTP' });
      }

      await config.database.otp.delete(otp.id);

      // Mode-specific teardown owns clearing material AND any enabled flag.
      await clearOnVerify(user.id);

      if (config.hooks?.onTwoFaStatusChanged) {
        await config.hooks.onTwoFaStatusChanged(user.id, false);
      }

      return { success: true, message: '2FA has been reset.' };
    });

  return { twoFaReset, twoFaResetVerify };
}
