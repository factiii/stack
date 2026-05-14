import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { ClientCookiePayload } from '../types';
import { type AuthProcedure } from '../types/trpc';
import type { ResolvedAuthConfig } from '../utilities/config';
import { clearAuthCookies, setAuthCookies } from '../utilities/cookies';
import { createAuthToken } from '../utilities/jwt';

export class MultiAccountProcedureFactory {
  constructor(
    private config: ResolvedAuthConfig,
    private authProcedure: AuthProcedure
  ) {}

  createMultiAccountProcedures() {
    return {
      switchSession: this.switchSession(),
      removeSession: this.removeSession(),
      clearBundle: this.clearBundle(),
    };
  }

  private async buildClientPayload(
    userId: number,
    updatedAt: Date
  ): Promise<ClientCookiePayload> {
    const base: ClientCookiePayload = {
      userId,
      updatedAt: updatedAt.toISOString(),
    };
    if (this.config.getClientCookiePayload) {
      const extra = await this.config.getClientCookiePayload(userId);
      return { ...base, ...extra };
    }
    return base;
  }

  private requireBundle(ctx: {
    bundleSessionIds?: number[];
    sessionId: number | null;
  }): { sessions: number[]; active: number } {
    if (!ctx.bundleSessionIds || ctx.sessionId === null) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'No active session bundle.',
      });
    }
    return { sessions: ctx.bundleSessionIds, active: ctx.sessionId };
  }

  /** Switch the active session to another id in the bundle. */
  private switchSession() {
    return this.authProcedure
      .input(z.object({ targetSessionId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { sessions, active } = this.requireBundle(ctx);
        const { targetSessionId } = input;

        if (targetSessionId === active) {
          return { success: true, userId: ctx.userId, alreadyActive: true };
        }
        if (!sessions.includes(targetSessionId)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Target session is not part of this bundle.',
          });
        }

        const target = await this.config.database.session.findById(targetSessionId);
        if (!target || target.revokedAt) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Target session is no longer valid.',
          });
        }

        if (target.user.status === 'BANNED') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Target account is banned.',
          });
        }

        if (target.user.status === 'DEACTIVATED') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Target account is deactivated.',
          });
        }

        const newJwt = createAuthToken(
          {
            id: targetSessionId,
            userId: target.userId,
            verifiedHumanAt: target.user.verifiedHumanAt,
            sessions,
          },
          {
            secret: this.config.secrets.jwt,
            expiresIn: this.config.tokenSettings.jwtExpiry,
          }
        );
        const clientPayload = await this.buildClientPayload(
          target.userId,
          target.user.updatedAt
        );
        setAuthCookies(
          ctx.res,
          newJwt,
          clientPayload,
          this.config.secrets.jwt,
          this.config.cookieSettings,
          this.config.storageKeys
        );

        return { success: true, userId: target.userId, alreadyActive: false };
      });
  }

  /** Revoke the target session globally; promote next if it was active, or clear cookies if it was the last. */
  private removeSession() {
    return this.authProcedure
      .input(z.object({ targetSessionId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        const { sessions, active } = this.requireBundle(ctx);
        const { targetSessionId } = input;

        if (!sessions.includes(targetSessionId)) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Target session is not part of this bundle.',
          });
        }

        const removed = await this.config.database.session.findById(targetSessionId);
        await this.config.database.session.revoke(targetSessionId);

        if (this.config.hooks?.onSessionRevoked && removed) {
          await this.config.hooks.onSessionRevoked(
            removed.id,
            removed.socketId,
            'Removed from bundle'
          );
        }

        const remaining = sessions.filter((id) => id !== targetSessionId);

        if (remaining.length === 0) {
          clearAuthCookies(
            ctx.res,
            this.config.cookieSettings,
            this.config.storageKeys
          );
          return { success: true, loggedOut: true, newActive: null };
        }

        const newActive = targetSessionId === active ? remaining[0] : active;

        let activeUserId = ctx.userId as number;
        let activeUpdatedAt = new Date();
        let activeVerifiedHumanAt: Date | null = null;
        if (newActive !== active) {
          const promoted = await this.config.database.session.findById(newActive);
          if (promoted) {
            activeUserId = promoted.userId;
            activeUpdatedAt = promoted.user.updatedAt;
            activeVerifiedHumanAt = promoted.user.verifiedHumanAt;
          }
        }

        const newJwt = createAuthToken(
          {
            id: newActive,
            userId: activeUserId,
            verifiedHumanAt: activeVerifiedHumanAt,
            sessions: remaining,
          },
          {
            secret: this.config.secrets.jwt,
            expiresIn: this.config.tokenSettings.jwtExpiry,
          }
        );
        const clientPayload = await this.buildClientPayload(activeUserId, activeUpdatedAt);
        setAuthCookies(
          ctx.res,
          newJwt,
          clientPayload,
          this.config.secrets.jwt,
          this.config.cookieSettings,
          this.config.storageKeys
        );

        return { success: true, loggedOut: false, newActive };
      });
  }

  /** Revoke every session in the bundle. "Log out of all accounts on this device." */
  private clearBundle() {
    return this.authProcedure.mutation(async ({ ctx }) => {
      const { sessions } = this.requireBundle(ctx);

      for (const id of sessions) {
        await this.config.database.session.revoke(id);
      }

      clearAuthCookies(ctx.res, this.config.cookieSettings, this.config.storageKeys);

      return { success: true, revokedCount: sessions.length };
    });
  }
}
