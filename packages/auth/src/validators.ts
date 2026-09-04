import { z } from 'zod';

import type { UsernameMode } from './types/config';
import type { AnyZodObject } from './types/zod';
import type { SchemaExtensions } from './types/hooks';

/**
 * Username validation regex - allows letters, numbers, and underscores
 */
const usernameValidationRegex = /^[a-zA-Z0-9_]+$/;

/**
 * Shape of a username wherever one is accepted: signup and `setUsername`.
 */
export const usernameSchema = z
  .string()
  .min(1, { message: 'Username is required' })
  .max(30, { message: 'Username must be 30 characters or less' })
  .regex(usernameValidationRegex, {
    message: 'Username can only contain letters, numbers, and underscores',
  });

/**
 * Schema for user registration.
 *
 * Username is REQUIRED here, which is the default and the behaviour every
 * release before 0.20.0 had. A consumer that sets
 * `features.usernameMode: 'optional'` gets `signupSchemaOptionalUsername`
 * instead — see `createSchemas`.
 */
export const signupSchema = z.object({
  username: usernameSchema,
  email: z
    .string()
    .max(254, { message: 'Email must be 254 characters or less' })
    .email({ message: 'Invalid email address' }),
  password: z
    .string()
    .min(8, { message: 'Password must contain at least 8 characters' })
    .max(72, { message: 'Password must be 72 characters or less' })
    .refine((val) => val.trim().length >= 8, {
      message: 'Password cannot be only whitespace',
    }),
});

/**
 * Signup for email-first consumers: no username at registration. The account
 * keeps a null username until it picks one through `auth.setUsername`. Still
 * validated and still unique when one IS supplied.
 */
export const signupSchemaOptionalUsername = signupSchema.extend({
  username: usernameSchema.optional(),
});

/**
 * Schema for user login
 */
export const loginSchema = z.object({
  username: z.string().min(1, { message: 'Username or email is required' }),
  password: z.string().min(1, { message: 'Password is required' }),
  code: z.string().optional(), // 2FA code
});

/**
 * Schema for OAuth login
 */
export const oAuthLoginSchema = z.object({
  idToken: z.string(),
  user: z
    .object({
      email: z.string().email().optional(),
    })
    .optional(),
  provider: z.enum(['GOOGLE', 'APPLE']),
});

/**
 * Schema for password reset request
 */
export const requestPasswordResetSchema = z.object({
  email: z.string().email({ message: 'Invalid email address' }),
});

/**
 * Schema for password reset confirmation
 */
export const resetPasswordSchema = z.object({
  token: z.string().min(1, { message: 'Reset token is required' }),
  password: z
    .string()
    .min(8, { message: 'Password must contain at least 8 characters' })
    .max(72, { message: 'Password must be 72 characters or less' }),
});

/**
 * Schema for checking password reset token
 */
export const checkPasswordResetSchema = z.object({
  token: z.string().min(1, { message: 'Reset token is required' }),
});

/**
 * Schema for changing password (authenticated)
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, { message: 'Current password is required' }),
  newPassword: z
    .string()
    .min(8, { message: 'New password must contain at least 8 characters' })
    .max(72, { message: 'Password must be 72 characters or less' }),
});

/**
 * Schema for email verification
 */
export const verifyEmailSchema = z.object({
  code: z.string().min(1, { message: 'Verification code is required' }),
});

/**
 * Schema for biometric verification
 */
export const biometricVerifySchema = z.object({});

/**
 * Schema for ending all sessions
 */
export const endAllSessionsSchema = z.object({
  skipCurrentSession: z.boolean().optional().default(true),
});

// ── 2FA validators are split by mode and re-exported for convenience ────────
//
// Mode-agnostic schemas (login challenge, password-gated disable, email reset)
// live in ./validators/twoFa.shared.ts and are re-exported here so existing
// imports continue to work.
//
// Mode-specific schemas (standard backup-code regen / device push-token CRUD)
// live in their own submodules and are imported directly by the corresponding
// procedure factories — they are NOT re-exported here, so a standard-mode
// consumer's tRPC client never sees device-flow input types and vice versa.
export {
  disableTwofaSchema,
  twoFaResetSchema,
  twoFaResetVerifySchema,
  twoFaVerifySchema,
  type TwoFaVerifyInput,
} from './validators/twoFa.shared';

export type SignupInput = z.infer<typeof signupSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type OAuthLoginInput = z.infer<typeof oAuthLoginSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type VerifyEmailInput = z.infer<typeof verifyEmailSchema>;

/** Schemas used by auth procedures */
export interface AuthSchemas {
  signup: AnyZodObject;
  login: AnyZodObject;
  oauth: AnyZodObject;
}

/**
 * Compute merged AnyZodObject type.
 * When TExt is defined, produces a schema with both base and extension shapes.
 * When TExt is undefined, produces the base schema.
 */
type MergedSchema<TBase extends AnyZodObject, TExt extends AnyZodObject | undefined> = [
  TExt,
] extends [AnyZodObject]
  ? z.ZodObject<TBase['shape'] & TExt['shape']>
  : TBase;

/**
 * The signup base a given `usernameMode` selects, at the type level.
 *
 * Only a mode that is *exactly* `'required'` gets the username-required base.
 * A consumer whose config is annotated (rather than `satisfies`-checked) widens
 * the field to the whole `UsernameMode` union, and a union resolves here to the
 * optional base — the looser of the two, so the compiler never demands a field
 * the runtime might not want. Runtime validation is authoritative either way.
 */
type SignupBase<TMode extends UsernameMode> = [TMode] extends ['required']
  ? typeof signupSchema
  : typeof signupSchemaOptionalUsername;

/** Result type from createSchemas - preserves concrete schema types */
export type CreatedSchemas<
  TExtensions extends SchemaExtensions = {},
  TMode extends UsernameMode = 'optional',
> = {
  signup: MergedSchema<SignupBase<TMode>, TExtensions['signup']>;
  login: MergedSchema<typeof loginSchema, TExtensions['login']>;
  oauth: MergedSchema<typeof oAuthLoginSchema, TExtensions['oauth']>;
};

export type SignupSchemaInput<
  TExtensions extends SchemaExtensions = {},
  TMode extends UsernameMode = 'optional',
> = z.infer<SignupBase<TMode>> &
  (TExtensions['signup'] extends AnyZodObject ? z.infer<TExtensions['signup']> : {});

export type LoginSchemaInput<TExtensions extends SchemaExtensions = {}> = LoginInput &
  (TExtensions['login'] extends AnyZodObject ? z.infer<TExtensions['login']> : {});

export type OAuthSchemaInput<TExtensions extends SchemaExtensions = {}> = OAuthLoginInput &
  (TExtensions['oauth'] extends AnyZodObject ? z.infer<TExtensions['oauth']> : {});

export type PasskeyRegisterMetaInput<
  TExtensions extends SchemaExtensions = {},
  TMode extends UsernameMode = 'optional',
> = Omit<SignupSchemaInput<TExtensions, TMode>, 'username' | 'email' | 'password'>;

export type PasskeyAuthMetaInput<TExtensions extends SchemaExtensions = {}> = Omit<
  LoginSchemaInput<TExtensions>,
  'username' | 'password' | 'code'
>;

/**
 * Create schemas with optional extensions merged in.
 *
 * `usernameMode` picks the signup base. It defaults to `'optional'` as of
 * 0.20.0 — a change from every prior release, which required a username
 * unconditionally. Username-first consumers must now say so explicitly.
 *
 * The mode is a type parameter as well as a runtime argument, so the returned
 * signup schema types match what it actually validates. Before 0.20.4 the type
 * was pinned to the username-required base whatever the mode said, and an
 * `'optional'` consumer could not call `register` without passing a username
 * it had explicitly opted out of collecting.
 */
export function createSchemas<
  TExtensions extends SchemaExtensions = {},
  TMode extends UsernameMode = 'optional',
>(extensions?: TExtensions, usernameMode?: TMode): CreatedSchemas<TExtensions, TMode> {
  const signupBase =
    (usernameMode ?? 'optional') === 'optional' ? signupSchemaOptionalUsername : signupSchema;
  return {
    signup: extensions?.signup ? signupBase.merge(extensions.signup) : signupBase,
    login: extensions?.login ? loginSchema.merge(extensions.login) : loginSchema,
    oauth: extensions?.oauth ? oAuthLoginSchema.merge(extensions.oauth) : oAuthLoginSchema,
  } as CreatedSchemas<TExtensions, TMode>;
}
