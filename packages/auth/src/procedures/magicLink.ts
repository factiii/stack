import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { type BaseProcedure } from '../types/trpc';
import { assertCanMintSession } from '../utilities/accountStatus';
import { detectBrowser } from '../utilities/browser';
import type { ResolvedAuthConfig } from '../utilities/config';
import { carryDeviceTwoFaSecret, revokeDeviceSessionsForUser } from '../utilities/issueCookies';
import { createSessionWithTokenAndCookie } from '../utilities/session';
import { runDeviceStep } from './twoFa/deviceStep';

const INVALID_LINK = 'This link has expired or is invalid';

/** Factory for magic link authentication procedures. */
export class MagicLinkProcedureFactory {
  constructor(
    private config: ResolvedAuthConfig,
    private procedure: BaseProcedure
  ) {}

  createMagicLinkProcedures() {
    return {
      verifyMagicLink: this.verifyMagicLink(),
    };
  }

  private checkConfig() {
    if (!this.config.features.magicLink) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
    if (!this.config.database.magicLink) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Magic link database adapter is not configured',
      });
    }
  }

  /**
   * Spend the link. `consume` is one conditional write, so it is true for exactly
   * one caller. An adapter written before it existed falls back to
   * read-then-`markUsed`, which is not atomic — the `usedAt` check in
   * `verifyMagicLink` is then the only guard, as it always was.
   */
  private async consume(id: string): Promise<boolean> {
    const db = this.config.database.magicLink!;
    if (db.consume) return db.consume(id);
    await db.markUsed(id);
    return true;
  }

  private verifyMagicLink() {
    return this.procedure
      .input(
        z.object({
          token: z.string(),
          // Second step for an account with 2FA on: a TOTP or backup code.
          twoFaCode: z.string().max(64).optional(),
          approvalNonce: z.string().max(256).optional(),
          devicePushToken: z.string().max(512).optional(),
          platform: z.enum(['ios', 'android', 'web']).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        this.checkConfig();
        const db = this.config.database.magicLink!;

        const magicLink = await db.findById(input.token);

        if (!magicLink || magicLink.usedAt) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: INVALID_LINK,
          });
        }

        if (magicLink.expiresAt < new Date()) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: INVALID_LINK,
          });
        }

        const user = await this.config.database.user.findById(magicLink.userId);
        if (!user) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: INVALID_LINK,
          });
        }

        // A link names an account by id, so nothing on the way here looked at its
        // status: a deactivated or banned account, or one the consumer refuses
        // (`beforeSessionMint`), stops before the second step and any push.
        await assertCanMintSession(this.config, user, { firstFactor: 'MAGIC_LINK', ip: ctx.ip });

        const userAgent = (ctx.headers as Record<string, string>)?.['user-agent'];

        // A magic link proves the inbox, an INBOX factor. An account with 2FA on
        // owes a DEVICE step before it gets a session — this path used to skip it.
        const step = await runDeviceStep(this.config, {
          user,
          firstFactor: 'MAGIC_LINK',
          code: input.twoFaCode,
          askApproval: async () =>
            this.config.hooks?.onDeviceStepRequired
              ? this.config.hooks.onDeviceStepRequired(user.id, {
                  ip: ctx.ip,
                  browserName: detectBrowser(userAgent ?? ''),
                  firstFactor: 'MAGIC_LINK',
                  input: {
                    platform: input.platform,
                    approvalNonce: input.approvalNonce,
                    devicePushToken: input.devicePushToken,
                  },
                })
              : null,
          // A link can live for days, so wrong second-step codes spend it, and two
          // requests racing on it push the device once.
          guard: {
            credentialKey: `magicLink:${magicLink.id}`,
            spend: () => this.consume(magicLink.id),
            lockApproval: true,
          },
        });

        if (step?.kind === 'pending') {
          // Approval finishes in the consumer's pending-login flow and never comes
          // back here, so the link is spent now.
          if (!(await this.consume(magicLink.id))) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: INVALID_LINK });
          }
          return {
            success: false,
            pendingLogin: true,
            pendingLoginId: step.pendingLoginId,
            userId: user.id,
            requires2FA: true,
          };
        }
        if (step?.kind === 'code') {
          // Left unspent, so the same link can come back with `twoFaCode`.
          return {
            success: false,
            requires2FA: true,
            userId: user.id,
          };
        }

        // Mark as used (single-use). Atomic, and before anything else changes:
        // of two requests racing on one link, the loser stops here without
        // retiring this device's sessions.
        if (!(await this.consume(magicLink.id))) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: INVALID_LINK });
        }

        // The link proves control of the address, so a session this device
        // already holds for the same account is stale, not a reason to refuse.
        const replacedSessionIds = await revokeDeviceSessionsForUser(
          this.config,
          ctx.headers.cookie,
          magicLink.userId
        );

        const browserName = userAgent ?? 'Unknown';

        // Let the host app inject extra session data (e.g., instanceId)
        const extraSessionData = this.config.hooks?.onBeforeMagicLinkSession
          ? await this.config.hooks.onBeforeMagicLinkSession(magicLink.userId)
          : {};

        const { sessionId } = await createSessionWithTokenAndCookie(
          this.config,
          {
            userId: magicLink.userId,
            browserName,
            socketId: null,
            extraSessionData,
          },
          ctx.res
        );

        // Same rule as the other sign-in paths: the device keeps the second
        // factor it already had. A magic link is not a reason to lose it.
        await carryDeviceTwoFaSecret(this.config, {
          userId: magicLink.userId,
          revokedSessionIds: replacedSessionIds,
          newSessionId: sessionId,
        });

        return { success: true };
      });
  }
}
