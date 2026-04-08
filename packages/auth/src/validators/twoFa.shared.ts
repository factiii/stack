/**
 * 2FA validators that are used by BOTH the standard and device flows
 * (login challenge, password-gated disable, email-OTP reset).
 */
import { z } from 'zod';

/** Login-time 2FA challenge code (TOTP digits or device push code). */
export const twoFaVerifySchema = z.object({
  code: z.string().min(6, { message: 'Verification code is required' }),
  sessionId: z.number().optional(),
});

/** Initiate a 2FA reset by re-authenticating with username + password. */
export const twoFaResetSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/** Confirm a 2FA reset by submitting the email OTP code. */
export const twoFaResetVerifySchema = z.object({
  code: z.number().min(100000).max(999999),
  username: z.string().min(1),
});

/** Disable 2FA — both modes require the user to re-confirm their password. */
export const disableTwofaSchema = z.object({
  password: z.string().min(1, { message: 'Password is required' }),
});

export type TwoFaVerifyInput = z.infer<typeof twoFaVerifySchema>;
