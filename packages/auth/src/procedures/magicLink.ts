import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { type BaseProcedure } from '../types/trpc';
import type { ResolvedAuthConfig } from '../utilities/config';
import { createSessionWithTokenAndCookie } from '../utilities/session';

/** Factory for magic link authentication procedures. */
export class MagicLinkProcedureFactory {
  constructor(
    private config: ResolvedAuthConfig,
    private procedure: BaseProcedure,
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

  private verifyMagicLink() {
    return this.procedure
      .input(z.object({ token: z.string() }))
      .mutation(async ({ ctx, input }) => {
        this.checkConfig();
        const db = this.config.database.magicLink!;

        const magicLink = await db.findById(input.token);

        if (!magicLink || magicLink.usedAt) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This link has expired or is invalid',
          });
        }

        if (magicLink.expiresAt < new Date()) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This link has expired or is invalid',
          });
        }

        // Mark as used (single-use)
        await db.markUsed(magicLink.id);

        const browserName =
          (ctx.headers as Record<string, string>)?.['user-agent'] ?? 'Unknown';

        // Let the host app inject extra session data (e.g., instanceId)
        const extraSessionData = this.config.hooks?.onBeforeMagicLinkSession
          ? await this.config.hooks.onBeforeMagicLinkSession(magicLink.userId)
          : {};

        await createSessionWithTokenAndCookie(
          this.config,
          {
            userId: magicLink.userId,
            browserName,
            socketId: null,
            extraSessionData,
          },
          ctx.res,
        );

        return { success: true };
      });
  }
}
