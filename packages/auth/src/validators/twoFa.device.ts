/**
 * Validators specific to the legacy device/push-token 2FA flow.
 * Imported only by the DeviceTwoFaProcedureFactory — these are NOT
 * exposed to consumers in standard mode.
 */
import { z } from 'zod';

/**
 * The device flow gates secret retrieval on a TOTP code derived from
 * the device's push token. The user proves possession of a registered
 * mobile device before the server hands out (or generates) the session
 * 2FA secret.
 */
export const getTwofaSecretSchema = z.object({
  pushCode: z.string().min(6, { message: 'Push code is required' }),
});

/** Register a mobile device by its push notification token. */
export const registerPushTokenSchema = z.object({
  pushToken: z.string().min(1, { message: 'Push token is required' }),
});

/** Deregister a mobile device by its push notification token. */
export const deregisterPushTokenSchema = z.object({
  pushToken: z.string().min(1, { message: 'Push token is required' }),
});
