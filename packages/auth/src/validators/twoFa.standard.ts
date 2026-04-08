/**
 * Validators specific to the standard (user-centric TOTP) 2FA flow.
 * Imported only by the StandardTwoFaProcedureFactory — these are NOT
 * exposed to consumers in device mode.
 */
import { z } from 'zod';

/** Re-confirm password to issue a fresh set of backup codes. */
export const regenerateBackupCodesSchema = z.object({
  password: z.string().min(1, { message: 'Password is required' }),
});
