import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { SchemaExtensions } from '../types/hooks';
import { type AuthProcedure, type BaseProcedure } from '../types/trpc';
import { detectBrowser } from '../utilities';
import type { ResolvedAuthConfig } from '../utilities/config';
import { issueAuthCookies, revokeDeviceSessionsForUser } from '../utilities/issueCookies';
import { assertKeepsLoginMethod } from '../utilities/loginMethods';
import { createOAuthVerifier, type OAuthProvider, type OAuthResult } from '../utilities/oauth';
import { type CreatedSchemas, type OAuthSchemaInput } from '../validators';

const providerEnum = z.enum(['GOOGLE', 'APPLE']);

/** Factory for OAuth login + link/unlink procedures (Google, Apple). */
export class OAuthLoginProcedureFactory<TExtensions extends SchemaExtensions = {}> {
  private verifyOAuthToken:
    | ((provider: OAuthProvider, token: string, extra?: { email?: string }) => Promise<OAuthResult>)
    | null = null;

  constructor(
    private config: ResolvedAuthConfig,
    private procedure: BaseProcedure,
    private authProcedure: AuthProcedure
  ) {
    if (config.oauthKeys) {
      this.verifyOAuthToken = createOAuthVerifier(config.oauthKeys);
    }
  }

  createOAuthLoginProcedures(schemas: CreatedSchemas<TExtensions>) {
    return {
      oAuthLogin: this.oAuthLogin(schemas.oauth),
      oAuthLink: this.oAuthLink(),
      oAuthUnlink: this.oAuthUnlink(),
    };
  }

  private checkConfig() {
    if (!this.config.features.oauth?.google && !this.config.features.oauth?.apple) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
  }

  private verifier() {
    if (!this.verifyOAuthToken) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'OAuth not configured. Provide oauthKeys in config.',
      });
    }
    return this.verifyOAuthToken;
  }

  private oAuthLogin(schema: CreatedSchemas<TExtensions>['oauth']) {
    return this.procedure.input(schema).mutation(async ({ ctx, input }) => {
      this.checkConfig();

      const typedInput = input as OAuthSchemaInput<TExtensions>;
      const { idToken, user: appleUser, provider } = typedInput;
      const userAgent = ctx.headers['user-agent'];

      if (!userAgent) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'User agent not found' });
      }

      const { email, oauthId } = await this.verifier()(provider, idToken, appleUser);

      // The OAuthAccount adapter is the source of truth for OAuth sign-in.
      if (!this.config.oauthAccounts) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'OAuth requires an `oauthAccounts` storage adapter.',
        });
      }

      // 1. A linked identity resolves straight to its account — even if the
      //    provider hid the email on this sign-in.
      const linked = await this.config.oauthAccounts.resolve(provider, oauthId);
      let user = linked ? await this.config.database.user.findActiveById(linked.userId) : null;
      if (linked && !user) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'This account is not available.' });
      }

      // 2. New identity: attach it to an existing passwordless account with the
      //    same email, else create one — then record the link.
      if (!user) {
        if (!email) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Email not provided by OAuth provider',
          });
        }

        const existing = await this.config.database.user.findByEmailInsensitive(email);
        if (existing?.password) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This email uses password login. Please use email/password.',
          });
        }

        let created = false;
        if (existing) {
          user = existing;
        } else {
          const generateUsername = this.config.generateUsername ?? (() => `user_${Date.now()}`);
          user = await this.config.database.user.create({
            username: generateUsername(),
            email,
            password: null,
            emailVerificationStatus: 'VERIFIED',
            status: 'ACTIVE',
            tag: this.config.features.biometric ? 'BOT' : 'HUMAN',
            verifiedHumanAt: null,
          });
          created = true;
        }

        // Link before provisioning so `onUserCreated` sees the provider.
        await this.config.oauthAccounts.link(user.id, {
          provider,
          subject: oauthId,
          email: email ?? null,
        });
        if (created && this.config.hooks?.onUserCreated) {
          await this.config.hooks.onUserCreated(user.id, typedInput);
        }
        if (this.config.hooks?.onOAuthLinked) {
          await this.config.hooks.onOAuthLinked(user.id, provider);
        }
      }

      if (user.status === 'DEACTIVATED') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Your account has been deactivated.' });
      }

      if (user.status === 'BANNED') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Your account has been banned.' });
      }

      // The provider has vouched for this identity, so a session this device
      // already holds for the same account is stale, not a reason to refuse.
      await revokeDeviceSessionsForUser(this.config, ctx.headers.cookie, user.id);

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
        verifiedHumanAt: user.verifiedHumanAt ?? null,
      });

      return {
        success: true,
        user: { id: user.id, email: user.email, username: user.username },
      };
    });
  }

  /** Attach a provider to the signed-in account (Settings). */
  private oAuthLink() {
    return this.authProcedure
      .input(
        z.object({
          provider: providerEnum,
          idToken: z.string(),
          user: z.object({ email: z.string().optional() }).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        this.checkConfig();
        if (!this.config.oauthAccounts) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'OAuth linking requires an `oauthAccounts` storage adapter.',
          });
        }

        const { email, oauthId } = await this.verifier()(input.provider, input.idToken, input.user);

        const existing = await this.config.oauthAccounts.resolve(input.provider, oauthId);
        if (existing && existing.userId !== ctx.userId) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `This ${input.provider === 'GOOGLE' ? 'Google' : 'Apple'} account is already linked to another account.`,
          });
        }
        // Past the CONFLICT guard, a truthy `existing` already belongs to us.
        if (!existing) {
          await this.config.oauthAccounts.link(ctx.userId, {
            provider: input.provider,
            subject: oauthId,
            email: email ?? null,
          });
          if (this.config.hooks?.onOAuthLinked) {
            await this.config.hooks.onOAuthLinked(ctx.userId, input.provider);
          }
        }

        return { success: true, provider: input.provider };
      });
  }

  /** Detach a provider. Refuses to remove the account's last sign-in method. */
  private oAuthUnlink() {
    return this.authProcedure
      .input(z.object({ provider: providerEnum }))
      .mutation(async ({ ctx, input }) => {
        this.checkConfig();
        if (!this.config.oauthAccounts) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'OAuth unlinking requires an `oauthAccounts` storage adapter.',
          });
        }
        await assertKeepsLoginMethod(this.config, ctx.userId, {
          kind: 'oauth',
          provider: input.provider,
        });
        await this.config.oauthAccounts.unlink(ctx.userId, input.provider);
        return { success: true };
      });
  }
}
