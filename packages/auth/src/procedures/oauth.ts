import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { AuthUser } from '../adapters/database';
import type { UsernameMode } from '../types/config';
import type { SchemaExtensions } from '../types/hooks';
import { type AuthProcedure, type BaseProcedure } from '../types/trpc';
import { detectBrowser } from '../utilities';
import { assertCanMintSession } from '../utilities/accountStatus';
import type { ResolvedAuthConfig } from '../utilities/config';
import { createUserWithFreshUsername } from '../utilities/createUser';
import { sameIdentifier } from '../utilities/emailMatch';
import {
  carryDeviceTwoFaSecret,
  issueAuthCookies,
  revokeDeviceSessionsForUser,
} from '../utilities/issueCookies';
import { assertKeepsLoginMethod } from '../utilities/loginMethods';
import { createOAuthVerifier, type OAuthProvider, type OAuthResult } from '../utilities/oauth';
import { type CreatedSchemas, type OAuthSchemaInput } from '../validators';
import { runDeviceStep } from './twoFa/deviceStep';

const providerEnum = z.enum(['GOOGLE', 'APPLE']);

/** Factory for OAuth login + link/unlink procedures (Google, Apple). */
export class OAuthLoginProcedureFactory<
  TExtensions extends SchemaExtensions = {},
  TMode extends UsernameMode = 'optional',
> {
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

  createOAuthLoginProcedures(schemas: CreatedSchemas<TExtensions, TMode>) {
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

  /** The factor-class gate for an OAuth sign-in into `user`. */
  private deviceStep(
    ip: string | undefined,
    user: AuthUser,
    input: OAuthSchemaInput<TExtensions>,
    userAgent: string,
    oauthId: string
  ) {
    return runDeviceStep(this.config, {
      user,
      firstFactor: 'OAUTH',
      code: input.twoFaCode,
      askApproval: async () => {
        if (!this.config.hooks?.onDeviceStepRequired) return null;
        // Everything the client sent except the provider token, which the hook
        // has no use for and should never be handed.
        const approvalInput: Record<string, unknown> = { ...input };
        delete approvalInput.idToken;
        return this.config.hooks.onDeviceStepRequired(user.id, {
          ip,
          browserName: detectBrowser(userAgent),
          firstFactor: 'OAUTH',
          input: approvalInput,
        });
      },
      // A provider token cannot be revoked from here, so nothing is spent; the
      // account-wide cap on second-step codes is what bounds guessing. No push
      // lock: each OAuth sign-in is its own ceremony with a fresh token.
      guard: { credentialKey: `oauth:${input.provider}:${oauthId}` },
    });
  }

  private oAuthLogin(schema: CreatedSchemas<TExtensions, TMode>['oauth']) {
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

      // Set once the factor-class gate has run for this sign-in, so the attach
      // branch and the final check below never ask twice.
      let deviceStepDone = false;
      // Set once the account-status rule has run, for the same reason.
      let statusChecked = false;

      // 2. New identity: attach it to an existing passwordless account with the
      //    same email, else create one — then record the link.
      if (!user) {
        if (!email) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Email not provided by OAuth provider',
          });
        }

        // Re-checked here as well as in the adapter: attaching by email hands over
        // the account, so a lookup result for a different address is not a match.
        const found = await this.config.database.user.findByEmailInsensitive(email);
        const existing = found && sameIdentifier(found.email, email) ? found : null;
        if (existing?.password) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This email uses password login. Please use email/password.',
          });
        }

        // Attaching by email is only safe when the address was PROVEN on the
        // account being attached to. Consumers can let a user store any unclaimed
        // address unverified, so an unverified match may be an account someone
        // else registered in the victim's name — and signing the victim into it
        // hands them an account the registrant still controls (pre-hijacking).
        // An adapter that omits the field refuses every attach: fail-closed.
        if (existing && existing.emailVerificationStatus !== 'VERIFIED') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Sign in another way, then link this provider from Settings.',
          });
        }

        let created = false;
        if (existing) {
          // Status before anything is attached: a refused account must not gain a
          // provider link on the way to being refused.
          await assertCanMintSession(this.config, existing, { firstFactor: 'OAUTH', ip: ctx.ip });
          statusChecked = true;

          // An account with 2FA on owes its DEVICE step before a new provider is
          // attached to it. Otherwise whoever holds the Google or Apple account
          // gains a standing way in that never passed the second factor.
          const step = await this.deviceStep(ctx.ip, existing, typedInput, userAgent, oauthId);
          if (step?.kind === 'pending') {
            return {
              success: false,
              pendingLogin: true,
              pendingLoginId: step.pendingLoginId,
              userId: existing.id,
              requires2FA: true,
            };
          }
          if (step?.kind === 'code') {
            return {
              success: false,
              requires2FA: true,
              userId: existing.id,
            };
          }
          deviceStepDone = true;
          user = existing;
        } else {
          // A taken generated username gets a fresh one; any other unique
          // violation is not recoverable here and propagates.
          user = await createUserWithFreshUsername(
            this.config,
            {
              email,
              password: null,
              emailVerificationStatus: 'VERIFIED',
              status: 'ACTIVE',
              tag: this.config.features.biometric ? 'BOT' : 'HUMAN',
              verifiedHumanAt: null,
            },
            { ip: ctx.ip }
          );
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

      // A linked identity, or a brand-new account, reaches here unchecked:
      // deactivated, banned, and the consumer's own rules (`beforeSessionMint`).
      if (!statusChecked) {
        await assertCanMintSession(this.config, user, { firstFactor: 'OAUTH', ip: ctx.ip });
      }

      // A linked identity reaches here without having been asked. Google or Apple
      // is an INBOX or FEDERATED factor, never DEVICE, so an account with 2FA on
      // still owes the step. A brand-new account has no 2FA, so this is a no-op.
      if (!deviceStepDone) {
        const step = await this.deviceStep(ctx.ip, user, typedInput, userAgent, oauthId);
        if (step?.kind === 'pending') {
          return {
            success: false,
            pendingLogin: true,
            pendingLoginId: step.pendingLoginId,
            userId: user.id,
            requires2FA: true,
          };
        }
        if (step?.kind === 'code') {
          return {
            success: false,
            requires2FA: true,
            userId: user.id,
          };
        }
      }

      // The provider has vouched for this identity, so a session this device
      // already holds for the same account is stale, not a reason to refuse.
      const replacedSessionIds = await revokeDeviceSessionsForUser(
        this.config,
        ctx.headers.cookie,
        user.id
      );

      const extraSessionData = this.config.hooks?.getSessionData
        ? await this.config.hooks.getSessionData(typedInput)
        : {};

      const session = await this.config.database.session.create({
        userId: user.id,
        browserName: detectBrowser(userAgent),
        socketId: null,
        ...extraSessionData,
      });

      // An OAuth account can still have device 2FA enrolled from a password it
      // used to have, so this path carries the secret like any other.
      await carryDeviceTwoFaSecret(this.config, {
        userId: user.id,
        revokedSessionIds: replacedSessionIds,
        newSessionId: session.id,
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
