/**
 * Device 2FA flow — legacy factiii mobile-bound TOTP.
 *
 * Secrets live on `Session.twoFaSecret`. Enrollment requires the user
 * to have already registered a mobile device (push token), and the
 * device's push token is reused as TOTP key material in `getTwofaSecret`.
 *
 * This is the *current* @factiii/auth behavior, preserved verbatim.
 * It is opt-in via `features.twoFaMode: 'device'` plus a `deviceAuth` adapter.
 */
import { TRPCError } from '@trpc/server';

import type { AuthUser } from '../../adapters/database';
import type { DeviceAuthAdapter } from '../../adapters/deviceAuth';
import { type AuthProcedure, type BaseProcedure } from '../../types/trpc';
import type { ResolvedAuthConfig } from '../../utilities/config';
import { comparePassword } from '../../utilities/password';
import { cleanBase32String, generateTotpSecret, verifyTotp } from '../../utilities/totp';
import { disableTwofaSchema } from '../../validators/twoFa.shared';
import {
  deregisterPushTokenSchema,
  getTwofaSecretSchema,
  registerPushTokenSchema,
} from '../../validators/twoFa.device';
import { buildTwoFaResetProcedures } from './shared';

/**
 * Verify a 2FA challenge in device mode.
 *
 * 1. Try the code as a TOTP against any of the user's session secrets
 *    (multi-device support — different sessions can hold different secrets).
 * 2. If that fails, try it as a 6-digit email OTP from the `otps` table.
 *
 * Returns true if either path succeeds. Used by `base.ts` at login.
 *
 * This is the original @factiii/auth login-challenge behavior, preserved
 * verbatim from `procedures/base.ts:218-237`.
 */
export async function verifyDeviceTwoFa(
  config: ResolvedAuthConfig,
  deviceAuth: DeviceAuthAdapter,
  user: AuthUser,
  code: string
): Promise<boolean> {
  const secrets = await deviceAuth.session.findTwoFaSecretsByUserId(user.id);

  for (const s of secrets) {
    if (s.twoFaSecret && (await verifyTotp(code, cleanBase32String(s.twoFaSecret)))) {
      return true;
    }
  }

  // Email OTP fallback (used by the device-mode reset flow as a one-time code).
  const checkOTP = await config.database.otp.findValidByUserAndCode(user.id, Number(code));
  if (checkOTP) {
    await config.database.otp.delete(checkOTP.id);
    return true;
  }

  return false;
}

/**
 * Device 2FA procedure factory — preserves the legacy factiii flow.
 *
 * Exposed procedures (only in device mode):
 * - `enableTwofa`           — requires registered device, generates session secret
 * - `disableTwofa`          — password-gated, clears session secret
 * - `getTwofaSecret`        — re-fetch the session secret using a device push code
 * - `registerPushToken`     — register a mobile device
 * - `deregisterPushToken`   — remove a mobile device
 * - `twoFaReset` / `twoFaResetVerify` — email-OTP recovery (from shared.ts)
 */
export class DeviceTwoFaProcedureFactory {
  constructor(
    private config: ResolvedAuthConfig,
    private deviceAuth: DeviceAuthAdapter,
    private procedure: BaseProcedure,
    private authProcedure: AuthProcedure
  ) {}

  createTwoFaProcedures() {
    const reset = buildTwoFaResetProcedures(
      this.config,
      this.procedure,
      // Device-mode reset: clear every session twoFaSecret AND flip the
      // user-level enabled flag (the only durable "is 2FA on" signal in
      // device mode, since secrets live on ephemeral sessions).
      async (userId) => {
        await this.deviceAuth.session.clearTwoFaSecrets(userId);
        await this.config.database.user.update(userId, { twoFaEnabled: false });
      }
    );

    return {
      enableTwofa: this.enableTwofa(),
      disableTwofa: this.disableTwofa(),
      getTwofaSecret: this.getTwofaSecret(),
      registerPushToken: this.registerPushToken(),
      deregisterPushToken: this.deregisterPushToken(),
      twoFaReset: reset.twoFaReset,
      twoFaResetVerify: reset.twoFaResetVerify,
    };
  }

  private checkConfig() {
    if (!this.config.features.twoFa) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
  }

  private enableTwofa() {
    return this.authProcedure.mutation(async ({ ctx }) => {
      this.checkConfig();
      const { userId, sessionId } = ctx;

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

      if (user.twoFaEnabled) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: '2FA already enabled.' });
      }

      // Device flow REQUIRES the current session to be linked to a device.
      const deviceId = await this.deviceAuth.session.getDeviceId(sessionId, userId);
      if (!deviceId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You must be logged in on mobile to enable 2FA.',
        });
      }

      await this.config.database.session.revokeAllByUserId(userId, sessionId);

      await this.deviceAuth.session.clearTwoFaSecrets(userId, sessionId);

      const secret = generateTotpSecret();

      await this.config.database.user.update(userId, { twoFaEnabled: true });

      await this.deviceAuth.session.setTwoFaSecret(sessionId, secret);

      if (this.config.hooks?.onTwoFaStatusChanged) {
        await this.config.hooks.onTwoFaStatusChanged(userId, true);
      }

      return { secret };
    });
  }

  private disableTwofa() {
    return this.authProcedure.input(disableTwofaSchema).mutation(async ({ ctx, input }) => {
      this.checkConfig();
      const { userId, sessionId } = ctx;
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

      await this.config.database.user.update(userId, { twoFaEnabled: false });

      await this.deviceAuth.session.setTwoFaSecret(sessionId, null);

      if (this.config.hooks?.onTwoFaStatusChanged) {
        await this.config.hooks.onTwoFaStatusChanged(userId, false);
      }

      return { disabled: true };
    });
  }

  private getTwofaSecret() {
    return this.authProcedure.input(getTwofaSecretSchema).query(async ({ ctx, input }) => {
      this.checkConfig();
      const { userId, sessionId } = ctx;
      const { pushCode } = input;

      const user = await this.config.database.user.findById(userId);

      if (user?.oauthProvider) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: '2FA is not available for social login accounts.',
        });
      }

      if (!user?.twoFaEnabled) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: '2FA not enabled.' });
      }

      const session = await this.deviceAuth.session.findByIdWithDevice(sessionId, userId);

      if (!session?.device) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid request' });
      }

      const expectedCode = await verifyTotp(pushCode, cleanBase32String(session.device.pushToken));
      if (!expectedCode) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid request' });
      }

      if (session.twoFaSecret) {
        return { secret: session.twoFaSecret };
      }

      const secret = generateTotpSecret();
      await this.deviceAuth.session.setTwoFaSecret(sessionId, secret);
      return { secret };
    });
  }

  private registerPushToken() {
    return this.authProcedure.input(registerPushTokenSchema).mutation(async ({ ctx, input }) => {
      this.checkConfig();
      const { userId, sessionId } = ctx;
      const { pushToken } = input;

      await this.deviceAuth.session.revokeByDevicePushToken(userId, pushToken, sessionId);

      const checkDevice = await this.deviceAuth.device.findByTokenSessionAndUser(
        pushToken,
        sessionId,
        userId
      );

      if (!checkDevice) {
        await this.deviceAuth.device.upsertByPushToken(pushToken, sessionId, userId);
      }

      return { registered: true };
    });
  }

  private deregisterPushToken() {
    return this.authProcedure
      .input(deregisterPushTokenSchema)
      .mutation(async ({ ctx, input }) => {
        this.checkConfig();
        const { userId } = ctx;
        const { pushToken } = input;

        const device = await this.deviceAuth.device.findByUserAndToken(userId, pushToken);

        if (device) {
          await this.deviceAuth.session.clearDeviceId(userId, device.id);

          await this.deviceAuth.device.disconnectUser(device.id, userId);

          const hasUsers = await this.deviceAuth.device.hasRemainingUsers(device.id);

          if (!hasUsers) {
            await this.deviceAuth.device.delete(device.id);
          }
        }

        return { deregistered: true };
      });
  }
}
