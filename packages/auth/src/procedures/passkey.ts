import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { TRPCError } from '@trpc/server';
import { z, type AnyZodObject } from 'zod';

import type { SchemaExtensions } from '../types/hooks';
import { type AuthProcedure, type BaseProcedure } from '../types/trpc';
import { detectBrowser } from '../utilities';
import type { ResolvedAuthConfig } from '../utilities/config';
import { issueAuthCookies, isUserInBundle } from '../utilities/issueCookies';
import { assertKeepsLoginMethod } from '../utilities/loginMethods';
import {
  type CreatedSchemas,
  type PasskeyAuthMetaInput,
  type PasskeyRegisterMetaInput,
} from '../validators';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null;

/**
 * Factory for WebAuthn passkey procedures (registerOptions / registerVerify /
 * authOptions / authVerify, plus addOptions / addVerify / list / remove for an
 * existing account). The package runs the ceremony and mints the session (via
 * `issueAuthCookies`, so passkey logins are bundle-aware just like password and
 * OAuth); the consumer owns all storage + user creation via `config.passkey`.
 */
export class PasskeyProcedureFactory<TExtensions extends SchemaExtensions = {}> {
  constructor(
    private config: ResolvedAuthConfig,
    private procedure: BaseProcedure,
    private authProcedure: AuthProcedure
  ) {}

  private checkConfig() {
    if (!this.config.features.passkey) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
    if (!this.config.webauthn) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Passkeys enabled but no `webauthn` config was provided.',
      });
    }
    if (!this.config.passkey) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Passkeys enabled but no `passkey` storage adapter was provided.',
      });
    }
    return { webauthn: this.config.webauthn, passkey: this.config.passkey };
  }

  createPasskeyProcedures(schemas: CreatedSchemas<TExtensions>) {
    // Signup metadata minus email/password, and minus username: the account is
    // created under the name bound to the challenge, so it always matches what
    // the authenticator saved.
    const registerMeta = (schemas.signup as AnyZodObject).omit({
      email: true,
      password: true,
      username: true,
    });
    const loginMeta = (schemas.login as AnyZodObject).omit({
      username: true,
      password: true,
      code: true,
    });

    return {
      registerOptions: this.registerOptions(),
      registerVerify: this.registerVerify(registerMeta),
      authOptions: this.authOptions(),
      authVerify: this.authVerify(loginMeta),
      // Add / list / remove for an already signed-in account.
      addOptions: this.addOptions(),
      addVerify: this.addVerify(),
      list: this.list(),
      remove: this.remove(),
    };
  }

  private addOptions() {
    return this.authProcedure.mutation(async ({ ctx }) => {
      const { webauthn, passkey } = this.checkConfig();
      const user = await this.config.database.user.findById(ctx.userId);
      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const existing = await passkey.list(ctx.userId);
      const options = await generateRegistrationOptions({
        rpName: webauthn.rpName,
        rpID: webauthn.rpID,
        userName: user.username,
        attestationType: 'none',
        // Exclude what's already registered so the same authenticator can't be
        // added twice — the concrete divergence from registerOptions.
        excludeCredentials: existing.map((c) => ({
          id: c.credentialId,
          transports: c.transports as AuthenticatorTransportFuture[],
        })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });

      const { flowId } = await passkey.storeChallenge({
        challenge: options.challenge,
        type: 'REGISTER',
        username: user.username,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      });

      return { flowId, options };
    });
  }

  private addVerify() {
    // `unknown` (not z.custom) so the inferred input matches registerVerify's,
    // which lets the client pass the ceremony response verbatim; validated +
    // narrowed below.
    const schema = z.object({
      flowId: z.string(),
      response: z.unknown(),
      name: z.string().max(60).optional(),
    });
    return this.authProcedure.input(schema).mutation(async ({ ctx, input }) => {
      const { webauthn, passkey } = this.checkConfig();
      if (!isObject(input.response)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid passkey response.' });
      }

      const challenge = await passkey.consumeChallenge(input.flowId);
      if (!challenge || challenge.type !== 'REGISTER') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Passkey challenge expired. Please try again.',
        });
      }
      // The challenge is bound to a username, so a stolen flowId can't attach a
      // credential to a different account.
      const user = await this.config.database.user.findById(ctx.userId);
      if (!user || user.username !== challenge.username) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Passkey challenge expired. Please try again.',
        });
      }

      const verification = await verifyRegistrationResponse({
        response: input.response as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: webauthn.origins,
        expectedRPID: webauthn.rpID,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Passkey verification failed.' });
      }

      const { credential, credentialDeviceType, credentialBackedUp } =
        verification.registrationInfo;

      const { id } = await passkey.add(ctx.userId, {
        credentialId: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: credential.transports ?? [],
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        name: input.name ?? null,
      });

      return { success: true, passkey: { id, name: input.name ?? null } };
    });
  }

  private list() {
    return this.authProcedure.query(async ({ ctx }) => {
      const { passkey } = this.checkConfig();
      const passkeys = await passkey.list(ctx.userId);
      return passkeys.map((p) => ({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt.toISOString(),
        lastUsedAt: p.lastUsedAt ? p.lastUsedAt.toISOString() : null,
      }));
    });
  }

  private remove() {
    return this.authProcedure
      .input(z.object({ id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const { passkey } = this.checkConfig();
        await assertKeepsLoginMethod(this.config, ctx.userId, { kind: 'passkey' });
        await passkey.remove(ctx.userId, input.id);
        return { success: true };
      });
  }

  private registerOptions() {
    return this.procedure
      .input(z.object({ username: z.string() }))
      .mutation(async ({ input }) => {
        const { webauthn, passkey } = this.checkConfig();

        const options = await generateRegistrationOptions({
          rpName: webauthn.rpName,
          rpID: webauthn.rpID,
          userName: input.username,
          attestationType: 'none',
          excludeCredentials: [],
          authenticatorSelection: {
            // Neither is negotiable: sign-in passes an empty allowCredentials so
            // a non-discoverable credential could never be offered back, and the
            // UV gesture is what makes a sole-factor passkey two-factor.
            residentKey: 'required',
            userVerification: 'required',
          },
        });

        const { flowId } = await passkey.storeChallenge({
          challenge: options.challenge,
          type: 'REGISTER',
          username: input.username,
          expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
        });

        return { flowId, options };
      });
  }

  private registerVerify(registerMeta: AnyZodObject) {
    const schema = registerMeta.extend({
      flowId: z.string(),
      response: z.custom<RegistrationResponseJSON>(isObject),
    });

    return this.procedure.input(schema).mutation(async ({ ctx, input }) => {
      const { webauthn, passkey } = this.checkConfig();
      const typedInput = input as PasskeyRegisterMetaInput<TExtensions> & {
        flowId: string;
        response: RegistrationResponseJSON;
      };

      const challenge = await passkey.consumeChallenge(typedInput.flowId);
      if (!challenge || challenge.type !== 'REGISTER' || !challenge.username) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Passkey challenge expired. Please try again.',
        });
      }

      const verification = await verifyRegistrationResponse({
        response: typedInput.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: webauthn.origins,
        expectedRPID: webauthn.rpID,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Passkey verification failed.' });
      }

      const { credential, credentialDeviceType, credentialBackedUp } =
        verification.registrationInfo;

      const { flowId: _flowId, response: _response, ...metadata } = typedInput;
      void _flowId;
      void _response;

      const { userId } = await passkey.createUser({
        ...metadata,
        // From the challenge, never from this request's body: see registerMeta.
        username: challenge.username,
        credential: {
          credentialId: credential.id,
          publicKey: credential.publicKey,
          counter: credential.counter,
          transports: credential.transports ?? [],
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
        },
      });

      // Same provisioning hook as password/OAuth signup — the adapter only
      // persists the user + credential, it doesn't re-implement provisioning.
      if (this.config.hooks?.onUserCreated) {
        await this.config.hooks.onUserCreated(userId, metadata);
      }

      return this.mintSession(ctx, userId, typedInput);
    });
  }

  private authOptions() {
    // No input: sign-in is fully discoverable, so there is nothing to send.
    return this.procedure.mutation(async () => {
      const { webauthn, passkey } = this.checkConfig();

      // Discoverable credentials, so no allowCredentials: avoids username
      // enumeration and enables conditional-UI autofill.
      const options = await generateAuthenticationOptions({
        rpID: webauthn.rpID,
        userVerification: 'required',
        allowCredentials: [],
      });

      const { flowId } = await passkey.storeChallenge({
        challenge: options.challenge,
        type: 'AUTH',
        username: null,
        expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
      });

      return { flowId, options };
    });
  }

  private authVerify(loginMeta: AnyZodObject) {
    // Auth carries the login extension fields (e.g. instanceId) but not
    // username/password/code.
    const schema = loginMeta.extend({
      flowId: z.string(),
      response: z.custom<AuthenticationResponseJSON>(isObject),
    });

    return this.procedure.input(schema).mutation(async ({ ctx, input }) => {
      const { webauthn, passkey } = this.checkConfig();
      const typedInput = input as PasskeyAuthMetaInput<TExtensions> & {
        flowId: string;
        response: AuthenticationResponseJSON;
      };

      const challenge = await passkey.consumeChallenge(typedInput.flowId);
      if (!challenge || challenge.type !== 'AUTH') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Passkey challenge expired. Please try again.',
        });
      }

      const stored = await passkey.resolveCredential(typedInput.response.id);
      if (!stored) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Passkey not recognized.' });
      }

      const verification = await verifyAuthenticationResponse({
        response: typedInput.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: webauthn.origins,
        expectedRPID: webauthn.rpID,
        requireUserVerification: true,
        credential: {
          id: typedInput.response.id,
          publicKey: new Uint8Array(stored.publicKey),
          counter: stored.counter,
          transports: stored.transports as AuthenticatorTransportFuture[],
        },
      });
      if (!verification.verified) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Passkey verification failed.' });
      }

      await passkey.onAuthenticated(
        typedInput.response.id,
        verification.authenticationInfo.newCounter
      );

      return this.mintSession(ctx, stored.userId, typedInput);
    });
  }

  /** Shared session issuance for passkey register + auth (bundle-aware cookie). */
  private async mintSession(
    ctx: Parameters<Parameters<BaseProcedure['mutation']>[0]>[0]['ctx'],
    userId: number,
    input: PasskeyRegisterMetaInput<TExtensions> | PasskeyAuthMetaInput<TExtensions>
  ) {
    const userAgent = ctx.headers['user-agent'];
    if (!userAgent) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'User agent not found' });
    }

    const user = await this.config.database.user.findById(userId);
    if (!user) {
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'User not found after passkey ceremony.' });
    }

    if (await isUserInBundle(this.config, ctx.headers.cookie, user.id)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'You are already signed in as this account on this device.',
      });
    }

    const extraSessionData = this.config.hooks?.getSessionData
      ? await this.config.hooks.getSessionData(input)
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
      await this.config.hooks.onSessionCreated(session.id, input);
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
  }
}
