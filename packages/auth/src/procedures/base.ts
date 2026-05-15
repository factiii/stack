import { TRPCError } from '@trpc/server';

import { type ClientCookiePayload } from '../types';
import { type AuthProcedure, type BaseProcedure } from '../types/trpc';
import { detectBrowser } from '../utilities/browser';
import { isTwoFaEnabled, verifyTwoFaChallenge } from './twoFa/verifyChallenge';
import type { ResolvedAuthConfig } from '../utilities/config';
import { clearAuthCookies, setAuthCookies } from '../utilities/cookies';
import { issueAuthCookies, isUserInBundle } from '../utilities/issueCookies';
import { createAuthToken } from '../utilities/jwt';
import { comparePassword, hashPassword } from '../utilities/password';
import type { SchemaExtensions } from '../types/hooks';
import {
  changePasswordSchema,
  checkPasswordResetSchema,
  endAllSessionsSchema,
  requestPasswordResetSchema,
  resetPasswordSchema,
  type CreatedSchemas,
  type SignupSchemaInput,
  type LoginSchemaInput,
} from '../validators';

/**
 * Factory for core authentication procedures: register, login, logout,
 * token refresh, session management, and password reset flows.
 */
export class BaseProcedureFactory<TExtensions extends SchemaExtensions = {}> {
  constructor(
    private config: ResolvedAuthConfig,
    private procedure: BaseProcedure,
    private authProcedure: AuthProcedure
  ) {}

  /** Build a client cookie payload, merging app-provided extra fields if configured. */
  private async buildClientPayload(userId: number, updatedAt: Date): Promise<ClientCookiePayload> {
    const base: ClientCookiePayload = { userId, updatedAt: updatedAt.toISOString() };
    if (this.config.getClientCookiePayload) {
      const extra = await this.config.getClientCookiePayload(userId);
      return { ...base, ...extra };
    }
    return base;
  }

  /** Returns all base auth procedures to be merged into the router. */
  createBaseProcedures(schemas: CreatedSchemas<TExtensions>) {
    return {
      register: this.register(schemas.signup),
      login: this.login(schemas.login),
      logout: this.logout(),
      refresh: this.refresh(),
      endAllSessions: this.endAllSessions(),
      changePassword: this.changePassword(),
      sendPasswordResetEmail: this.sendPasswordResetEmail(),
      checkPasswordReset: this.checkPasswordReset(),
      resetPassword: this.resetPassword(),
    };
  }

  private register(schema: CreatedSchemas<TExtensions>['signup']) {
    return this.procedure.input(schema).mutation(async ({ ctx, input }) => {
      const typedInput = input as SignupSchemaInput<TExtensions>;
      const { username, email, password } = typedInput;
      const userAgent = ctx.headers['user-agent'];

      if (!userAgent) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'User agent not found',
        });
      }

      if (this.config.hooks?.beforeRegister) {
        await this.config.hooks.beforeRegister(typedInput);
      }

      const usernameCheck = await this.config.database.user.findByUsernameInsensitive(username);

      if (usernameCheck) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'An account already exists with that username.',
        });
      }

      const emailCheck = await this.config.database.user.findByEmailInsensitive(email);

      if (emailCheck) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'An account already exists with that email.',
        });
      }

      const hashedPassword = await hashPassword(password);

      const user = await this.config.database.user.create({
        username,
        email,
        password: hashedPassword,
        status: 'ACTIVE',
        tag: this.config.features.biometric ? 'BOT' : 'HUMAN',
        emailVerificationStatus: 'UNVERIFIED',
        verifiedHumanAt: null,
      });

      if (this.config.hooks?.onUserCreated) {
        await this.config.hooks.onUserCreated(user.id, typedInput);
      }

      const extraSessionData = this.config.hooks?.getSessionData
        ? await this.config.hooks.getSessionData(typedInput)
        : {};

      const session = await this.config.database.session.create({
        userId: user.id,
        browserName: detectBrowser(userAgent),
        socketId: null,
        ...extraSessionData,
      });

      if (this.config.hooks?.onSessionCreated) {
        await this.config.hooks.onSessionCreated(session.id, typedInput);
      }

      await issueAuthCookies(this.config, {
        ctx,
        session,
        updatedAt: new Date(),
        verifiedHumanAt: null,
      });

      return {
        success: true,
        user: { id: user.id, email: user.email, username: user.username },
      };
    });
  }

  private login(schema: CreatedSchemas<TExtensions>['login']) {
    return this.procedure.input(schema).mutation(async ({ ctx, input }) => {
      const typedInput = input as LoginSchemaInput<TExtensions>;
      const { username, password, code } = typedInput;
      const userAgent = ctx.headers['user-agent'];

      if (!userAgent) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'User agent not found',
        });
      }

      if (this.config.hooks?.beforeLogin) {
        await this.config.hooks.beforeLogin(typedInput);
      }

      const user = await this.config.database.user.findByEmailOrUsernameInsensitive(username);

      if (!user) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Invalid credentials.',
        });
      }

      if (user.status === 'DEACTIVATED') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Your account has been deactivated.',
        });
      }

      if (user.status === 'BANNED') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Your account has been banned.',
        });
      }

      if (!user.password) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `This account uses ${user.oauthProvider?.toLowerCase() || 'social login'}. Please use that method.`,
        });
      }

      const isMatch = await comparePassword(password, user.password);
      if (!isMatch) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Invalid credentials.',
        });
      }

      if (isTwoFaEnabled(this.config, user) && this.config.features?.twoFa) {
        if (!code) {
          return {
            success: false,
            requires2FA: true,
            userId: user.id,
          };
        }

        const valid = await verifyTwoFaChallenge(this.config, user, code);
        if (!valid) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Invalid 2FA code.',
          });
        }
      }

      if (await isUserInBundle(this.config, ctx.headers.cookie, user.id)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'You are already signed in as this account on this device.',
        });
      }

      const extraSessionData = this.config.hooks?.getSessionData
        ? await this.config.hooks.getSessionData(typedInput)
        : {};

      const session = await this.config.database.session.create({
        userId: user.id,
        browserName: detectBrowser(userAgent),
        socketId: null,
        ...extraSessionData,
      });

      if (this.config.hooks?.onUserLogin) {
        await this.config.hooks.onUserLogin(user.id, session.id);
      }

      if (this.config.hooks?.onSessionCreated) {
        await this.config.hooks.onSessionCreated(session.id, typedInput);
      }

      await issueAuthCookies(this.config, {
        ctx,
        session,
        updatedAt: user.updatedAt,
        verifiedHumanAt: user.verifiedHumanAt,
      });

      return {
        success: true,
        user: { id: user.id, email: user.email, username: user.username },
      };
    });
  }

  private logout() {
    return this.procedure.mutation(async ({ ctx }) => {
      const { sessionId, bundleSessionIds } = ctx;

      if (sessionId) {
        const idsToRevoke =
          bundleSessionIds && bundleSessionIds.length > 0 ? bundleSessionIds : [sessionId];
        const revoked: Array<{ id: number; userId: number; socketId: string | null }> = [];

        for (const id of idsToRevoke) {
          const session = await this.config.database.session.findById(id);
          if (!session || session.revokedAt) continue;

          await this.config.database.session.revoke(id);
          revoked.push({ id: session.id, userId: session.userId, socketId: session.socketId });

          if (this.config.hooks?.onSessionRevoked) {
            try {
              await this.config.hooks.onSessionRevoked(
                session.id,
                session.socketId,
                'User logged out',
              );
            } catch {
              // Don't let a flaky hook abort the rest of the logout.
            }
          }
        }

        for (const uid of new Set(revoked.map((s) => s.userId))) {
          await this.config.database.user.update(uid, { isActive: false });
        }

        const active = revoked.find((s) => s.id === sessionId);
        if (active && this.config.hooks?.afterLogout) {
          const others = revoked
            .filter((s) => s.id !== sessionId)
            .map((s) => ({ userId: s.userId, sessionId: s.id, socketId: s.socketId }));
          try {
            await this.config.hooks.afterLogout(active.userId, active.id, active.socketId, others);
          } catch {
            // Don't let a flaky hook abort the rest of the logout.
          }
        }
      }

      clearAuthCookies(ctx.res, this.config.cookieSettings, this.config.storageKeys);

      return { success: true };
    });
  }

  private refresh() {
    return this.authProcedure.query(async ({ ctx }) => {
      const session = await this.config.database.session.updateLastUsed(ctx.sessionId);

      if (this.config.hooks?.onRefresh) {
        this.config.hooks.onRefresh(session.userId).catch(() => {});
      }

      const clientPayload = await this.buildClientPayload(session.userId, session.user.updatedAt);
      const sessions = ctx.bundleSessionIds ?? [session.id];
      const authToken = createAuthToken(
        {
          id: session.id,
          userId: session.userId,
          verifiedHumanAt: session.user.verifiedHumanAt,
          sessions,
        },
        { secret: this.config.secrets.jwt, expiresIn: this.config.tokenSettings.jwtExpiry }
      );
      setAuthCookies(
        ctx.res,
        authToken,
        clientPayload,
        this.config.secrets.jwt,
        this.config.cookieSettings,
        this.config.storageKeys,
      );

      return { success: true };
    });
  }

  private endAllSessions() {
    return this.authProcedure.input(endAllSessionsSchema).mutation(async ({ ctx, input }) => {
      const { skipCurrentSession } = input;
      const { userId, sessionId } = ctx;

      const sessionsToRevoke = await this.config.database.session.findActiveByUserId(
        userId,
        skipCurrentSession ? sessionId : undefined
      );

      await this.config.database.session.revokeAllByUserId(
        userId,
        skipCurrentSession ? sessionId : undefined
      );

      for (const session of sessionsToRevoke) {
        if (this.config.hooks?.onSessionRevoked) {
          await this.config.hooks.onSessionRevoked(
            session.id,
            session.socketId,
            'End all sessions'
          );
        }
      }

      if (!skipCurrentSession) {
        await this.config.database.user.update(userId, { isActive: false });
      }

      return { success: true, revokedCount: sessionsToRevoke.length };
    });
  }

  private changePassword() {
    return this.authProcedure.input(changePasswordSchema).mutation(async ({ ctx, input }) => {
      const { userId, sessionId } = ctx;
      const { currentPassword, newPassword } = input;

      if (currentPassword === newPassword) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'New password cannot be the same as current password',
        });
      }

      const user = await this.config.database.user.findById(userId);

      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      if (!user.password) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This account uses social login and cannot change password.',
        });
      }

      const isMatch = await comparePassword(currentPassword, user.password);
      if (!isMatch) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Current password is incorrect',
        });
      }

      const hashedPassword = await hashPassword(newPassword);

      await this.config.database.user.update(userId, { password: hashedPassword });

      await this.config.database.session.revokeAllByUserId(userId, sessionId);

      if (this.config.hooks?.onPasswordChanged) {
        await this.config.hooks.onPasswordChanged(userId);
      }

      return {
        success: true,
        message: 'Password changed. You will need to re-login on other devices.',
      };
    });
  }

  private sendPasswordResetEmail() {
    return this.procedure.input(requestPasswordResetSchema).mutation(async ({ input }) => {
      const { email } = input;

      const user = await this.config.database.user.findByEmailInsensitive(email);

      if (!user || user.status !== 'ACTIVE') {
        return { message: 'If an account exists with that email, a reset link has been sent.' };
      }

      if (!user.password) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This account uses social login. Please use that method.',
        });
      }

      await this.config.database.passwordReset.deleteAllByUserId(user.id);

      const passwordReset = await this.config.database.passwordReset.create(user.id);

      if (this.config.emailService) {
        await this.config.emailService.sendPasswordResetEmail(user.email, String(passwordReset.id));
      }

      return { message: 'Password reset email sent.' };
    });
  }

  private checkPasswordReset() {
    return this.procedure.input(checkPasswordResetSchema).query(async ({ input }) => {
      const { token } = input;

      const passwordReset = await this.config.database.passwordReset.findById(token);

      if (!passwordReset) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid reset token.' });
      }

      if (
        passwordReset.createdAt.getTime() + this.config.tokenSettings.passwordResetExpiryMs <
        Date.now()
      ) {
        await this.config.database.passwordReset.delete(token);
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Reset token expired.' });
      }

      return { valid: true };
    });
  }

  private resetPassword() {
    return this.procedure.input(resetPasswordSchema).mutation(async ({ input }) => {
      const { token, password } = input;

      const passwordReset = await this.config.database.passwordReset.findById(token);

      if (!passwordReset) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Invalid reset token.' });
      }

      if (
        passwordReset.createdAt.getTime() + this.config.tokenSettings.passwordResetExpiryMs <
        Date.now()
      ) {
        await this.config.database.passwordReset.delete(token);
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Reset token expired.' });
      }

      const hashedPassword = await hashPassword(password);

      await this.config.database.user.update(passwordReset.userId, {
        password: hashedPassword,
      });

      await this.config.database.passwordReset.delete(token);

      const sessionsToRevoke = await this.config.database.session.findActiveByUserId(
        passwordReset.userId
      );

      await this.config.database.session.revokeAllByUserId(passwordReset.userId);

      for (const session of sessionsToRevoke) {
        if (this.config.hooks?.onSessionRevoked) {
          await this.config.hooks.onSessionRevoked(
            session.id,
            session.socketId,
            'Password reset'
          );
        }
      }

      return { message: 'Password updated. Please log in with your new password.' };
    });
  }
}
