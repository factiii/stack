/**
 * Standard 2FA flow — user-centric TOTP with backup codes.
 *
 * This is the default 2FA implementation. The TOTP secret lives on the
 * `User` row (`User.twoFaSecret`) and recovery is handled by single-use
 * backup codes (`User.twoFaBackupCodes`).
 *
 * Compatible with any standard authenticator app: Google Authenticator,
 * 1Password, Authy, Bitwarden, etc.
 */
import crypto from 'crypto';

import { TRPCError } from '@trpc/server';

import type { AuthUser } from '../../adapters/database';
import { type AuthProcedure, type BaseProcedure } from '../../types/trpc';
import type { ResolvedAuthConfig } from '../../utilities/config';
import { comparePassword } from '../../utilities/password';
import { cleanBase32String, generateTotpSecret, verifyTotp } from '../../utilities/totp';
import { disableTwofaSchema } from '../../validators/twoFa.shared';
import { regenerateBackupCodesSchema } from '../../validators/twoFa.standard';
import { buildTwoFaResetProcedures } from './shared';

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_BYTES = 5; // 10 hex chars per code

/** Generate `BACKUP_CODE_COUNT` random hex backup codes. */
function generateBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () =>
    crypto.randomBytes(BACKUP_CODE_BYTES).toString('hex')
  );
}

/** Build a standard `otpauth://` URL for QR-code rendering on the client. */
function buildOtpAuthUrl(user: AuthUser, secret: string): string {
  const issuer = encodeURIComponent('factiii');
  const label = encodeURIComponent(`${issuer}:${user.email}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}`;
}

/**
 * Verify a 2FA challenge in standard mode.
 *
 * 1. Try the code as a TOTP against `user.twoFaSecret`.
 * 2. If that fails, try it as a backup code (atomic consume).
 *
 * Returns true if either path succeeds. Used by `base.ts` at login.
 */
export async function verifyStandardTwoFa(
  config: ResolvedAuthConfig,
  user: AuthUser,
  code: string
): Promise<boolean> {
  const trimmed = code.trim();

  if (user.twoFaSecret) {
    const totpValid = await verifyTotp(trimmed, cleanBase32String(user.twoFaSecret));
    if (totpValid) return true;
  }

  // Backup code fallback — atomic remove-if-present
  const consumed = await config.database.user.consumeBackupCode(user.id, trimmed);
  return consumed;
}

/**
 * Standard 2FA procedure factory.
 *
 * Exposed procedures (only in standard mode):
 * - `enableTwofa`           — generate secret + backup codes, flip enabled flag
 * - `disableTwofa`          — re-confirm password, clear secret + backup codes
 * - `regenerateBackupCodes` — issue a fresh batch of backup codes
 * - `twoFaReset` / `twoFaResetVerify` — email-OTP recovery (from shared.ts)
 *
 * Notably, this factory does NOT expose `getTwofaSecret`,
 * `registerPushToken`, or `deregisterPushToken` — those are device-flow
 * concepts and only the device factory exposes them.
 */
export class StandardTwoFaProcedureFactory {
  constructor(
    private config: ResolvedAuthConfig,
    private procedure: BaseProcedure,
    private authProcedure: AuthProcedure
  ) {}

  createTwoFaProcedures() {
    const reset = buildTwoFaResetProcedures(
      this.config,
      this.procedure,
      // Standard-mode reset clears the user-level secret + backup codes.
      async (userId) => {
        await this.config.database.user.clearTwoFaSecret(userId);
      }
    );

    return {
      enableTwofa: this.enableTwofa(),
      disableTwofa: this.disableTwofa(),
      regenerateBackupCodes: this.regenerateBackupCodes(),
      twoFaReset: reset.twoFaReset,
      twoFaResetVerify: reset.twoFaResetVerify,
    };
  }

  private checkConfig() {
    if (!this.config.features.twoFa) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
  }

  /**
   * Generate a fresh TOTP secret + backup codes and persist them on the user.
   *
   * Returns `{ secret, backupCodes, otpauthUrl }` so the client can render a
   * QR code, copy the secret manually, and store the backup codes somewhere
   * safe. The `onTwoFaStatusChanged` hook fires synchronously.
   *
   * Standard mode has no separate `twoFaEnabled` column — 2FA is "on" iff
   * `twoFaSecret` is non-null. A single atomic write covers enrollment.
   *
   * NOTE: This is a single-step enable. If you want a "scan + confirm" UX
   * where the user proves they entered the secret correctly before 2FA
   * actually turns on, gate the UI flow on a separate verify call (the same
   * code that would later be used at login works for this).
   */
  private enableTwofa() {
    return this.authProcedure.mutation(async ({ ctx }) => {
      this.checkConfig();
      const { userId } = ctx;

      const user = await this.config.database.user.findById(userId);

      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found.' });
      }

      if (user.oauthProvider) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: '2FA is not available for social login accounts.',
        });
      }

      if (user.twoFaSecret) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: '2FA already enabled.' });
      }

      const secret = generateTotpSecret();
      const backupCodes = generateBackupCodes();

      await this.config.database.user.setTwoFaSecret(userId, secret, backupCodes);

      if (this.config.hooks?.onTwoFaStatusChanged) {
        await this.config.hooks.onTwoFaStatusChanged(userId, true);
      }

      return {
        secret,
        backupCodes,
        otpauthUrl: buildOtpAuthUrl(user, secret),
      };
    });
  }

  private disableTwofa() {
    return this.authProcedure.input(disableTwofaSchema).mutation(async ({ ctx, input }) => {
      this.checkConfig();
      const { userId } = ctx;
      const { password } = input;

      const user = await this.config.database.user.findById(userId);

      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found.' });
      }

      if (user.status !== 'ACTIVE') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Account deactivated.' });
      }

      if (user.oauthProvider) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: '2FA is not available for social login accounts.',
        });
      }

      if (!user.password) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot verify password for social login account.',
        });
      }

      const isMatch = await comparePassword(password, user.password);
      if (!isMatch) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Incorrect password.' });
      }

      await this.config.database.user.clearTwoFaSecret(userId);

      if (this.config.hooks?.onTwoFaStatusChanged) {
        await this.config.hooks.onTwoFaStatusChanged(userId, false);
      }

      return { disabled: true };
    });
  }

  private regenerateBackupCodes() {
    return this.authProcedure
      .input(regenerateBackupCodesSchema)
      .mutation(async ({ ctx, input }) => {
        this.checkConfig();
        const { userId } = ctx;
        const { password } = input;

        const user = await this.config.database.user.findById(userId);

        if (!user || !user.twoFaSecret) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: '2FA not enabled.' });
        }
        if (!user.password) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot verify password for social login account.',
          });
        }

        const isMatch = await comparePassword(password, user.password);
        if (!isMatch) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Incorrect password.' });
        }

        const backupCodes = generateBackupCodes();
        await this.config.database.user.setBackupCodes(userId, backupCodes);

        return { backupCodes };
      });
  }
}

