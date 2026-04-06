import { TRPCError } from '@trpc/server';

import { type AuthProcedure, type BaseProcedure } from '../types/trpc';
import type { ResolvedAuthConfig } from '../utilities/config';
import { comparePassword } from '../utilities/password';
import { cleanBase32String, generateOtp, generateTotpSecret, verifyTotp } from '../utilities/totp';
import {
  deregisterPushTokenSchema,
  disableTwofaSchema,
  getTwofaSecretSchema,
  registerPushTokenSchema,
  twoFaResetSchema,
  twoFaResetVerifySchema,
} from '../validators';

/** Factory for 2FA procedures: enable/disable, TOTP secrets, and reset flows. */
export class TwoFaProcedureFactory {
  constructor(
    private config: ResolvedAuthConfig,
    private procedure: BaseProcedure,
    private authProcedure: AuthProcedure
  ) {}

  createTwoFaProcedures() {
    return {
      enableTwofa: this.enableTwofa(),
      disableTwofa: this.disableTwofa(),
      getTwofaSecret: this.getTwofaSecret(),
      twoFaReset: this.twoFaReset(),
      twoFaResetVerify: this.twoFaResetVerify(),
      registerPushToken: this.registerPushToken(),
      deregisterPushToken: this.deregisterPushToken(),
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

      if (this.config.features.twoFaRequiresDevice !== false) {
        const checkSession = await this.config.database.session.findById(sessionId);

        if (!checkSession?.deviceId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'You must be logged in on mobile to enable 2FA.',
          });
        }
      }

      await this.config.database.session.revokeAllByUserId(userId, sessionId);

      await this.config.database.session.clearTwoFaSecrets(userId, sessionId);

      const secret = generateTotpSecret();

      await this.config.database.user.update(userId, { twoFaEnabled: true });

      await this.config.database.session.update(sessionId, { twoFaSecret: secret });

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

      await this.config.database.session.update(sessionId, { twoFaSecret: null });

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

      const session = await this.config.database.session.findByIdWithDevice(sessionId, userId);

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
      await this.config.database.session.update(sessionId, { twoFaSecret: secret });
      return { secret };
    });
  }

  private twoFaReset() {
    return this.procedure.input(twoFaResetSchema).mutation(async ({ input }) => {
      this.checkConfig();
      const { username, password } = input;

      const user = await this.config.database.user.findByEmailOrUsernameInsensitive(username);

      if (!user || !user.twoFaEnabled) {
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
      const expiresAt = new Date(Date.now() + this.config.tokenSettings.otpValidityMs);

      await this.config.database.otp.create({ userId: user.id, code: otp, expiresAt });

      if (this.config.emailService) {
        await this.config.emailService.sendOTPEmail(user.email, otp);
      }

      return { success: true };
    });
  }

  private twoFaResetVerify() {
    return this.procedure.input(twoFaResetVerifySchema).mutation(async ({ input }) => {
      this.checkConfig();
      const { code, username } = input;

      const user = await this.config.database.user.findByEmailOrUsernameInsensitive(username);

      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const otp = await this.config.database.otp.findValidByUserAndCode(user.id, code);

      if (!otp) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Invalid or expired OTP' });
      }

      await this.config.database.otp.delete(otp.id);

      await this.config.database.user.update(user.id, { twoFaEnabled: false });

      await this.config.database.session.clearTwoFaSecrets(user.id);

      return { success: true, message: '2FA has been reset.' };
    });
  }

  private registerPushToken() {
    return this.authProcedure.input(registerPushTokenSchema).mutation(async ({ ctx, input }) => {
      this.checkConfig();
      const { userId, sessionId } = ctx;
      const { pushToken } = input;

      await this.config.database.session.revokeByDevicePushToken(userId, pushToken, sessionId);

      const checkDevice = await this.config.database.device.findByTokenSessionAndUser(
        pushToken,
        sessionId,
        userId
      );

      if (!checkDevice) {
        await this.config.database.device.upsertByPushToken(pushToken, sessionId, userId);
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

        const device = await this.config.database.device.findByUserAndToken(userId, pushToken);

        if (device) {
          await this.config.database.session.clearDeviceId(userId, device.id);

          await this.config.database.device.disconnectUser(device.id, userId);

          const hasUsers = await this.config.database.device.hasRemainingUsers(device.id);

          if (!hasUsers) {
            await this.config.database.device.delete(device.id);
          }
        }

        return { deregistered: true };
      });
  }
}
