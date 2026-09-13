/* eslint-disable no-console */

/** Extra context for a password reset email. */
export interface PasswordResetEmailOptions {
  /** The `emailLogin.apps` key the reset was requested from. */
  app?: string;
  /** The full reset URL on that app's site, token included. */
  resetUrl?: string;
}

/**
 * One email sign-in attempt. The link and the code are the same attempt: send
 * both, and whichever the person uses first spends the other.
 */
export interface LoginEmailParams {
  to: string;
  /** The `emailLogin.apps` key that asked. */
  app: string;
  /** That app's `brand`, for choosing the template. */
  brand: string;
  /** Opens the app's confirm page; it signs nobody in until they tap Continue. */
  link: string;
  /** Six digits, for typing into the app. */
  code: string;
  expiresAt: Date;
}

/**
 * Email service adapter interface
 * Implement this interface to integrate your email service
 */
export interface EmailAdapter {
  /**
   * Send email verification email with OTP code
   */
  sendVerificationEmail(email: string, code: string): Promise<void>;

  /**
   * Send password reset email with token/link. `options` is present when the
   * request named an app, so the link can open on that app's site.
   */
  sendPasswordResetEmail(
    email: string,
    token: string,
    options?: PasswordResetEmailOptions
  ): Promise<void>;

  /**
   * Send OTP for passwordless login or 2FA reset
   */
  sendOTPEmail(email: string, otp: number): Promise<void>;

  /**
   * Send an email sign-in link and code. Required when `features.emailLogin` is on.
   */
  sendLoginEmail?(params: LoginEmailParams): Promise<void>;

  /**
   * Send login notification to existing devices
   */
  sendLoginNotification?(email: string, browserName: string, ip?: string): Promise<void>;
}

/**
 * No-op email adapter as default
 */
export function createNoopEmailAdapter(): EmailAdapter {
  return {
    async sendVerificationEmail(email: string, code: string) {
      console.debug(
        `[NoopEmailAdapter] Would send verification email to ${email} with code ${code}`
      );
    },
    async sendPasswordResetEmail(email: string, token: string) {
      console.debug(
        `[NoopEmailAdapter] Would send password reset email to ${email} with token ${token}`
      );
    },
    async sendOTPEmail(email: string, otp: number) {
      console.debug(`[NoopEmailAdapter] Would send OTP email to ${email} with code ${otp}`);
    },
    async sendLoginEmail(params: LoginEmailParams) {
      console.debug(`[NoopEmailAdapter] Would send a ${params.brand} sign-in email to ${params.to}`);
    },
    async sendLoginNotification(email: string, browserName: string, ip?: string) {
      console.debug(
        `[NoopEmailAdapter] Would send login notification to ${email} from ${browserName} (${ip})`
      );
    },
  };
}

/**
 * Console email adapter for development - logs emails to console
 */
export function createConsoleEmailAdapter(): EmailAdapter {
  return {
    async sendVerificationEmail(email: string, code: string) {
      console.log('\n=== EMAIL: Verification ===');
      console.log(`To: ${email}`);
      console.log(`Code: ${code}`);
      console.log('===========================\n');
    },
    async sendPasswordResetEmail(email: string, token: string, options?: PasswordResetEmailOptions) {
      console.log('\n=== EMAIL: Password Reset ===');
      console.log(`To: ${email}`);
      console.log(`Token: ${token}`);
      if (options?.resetUrl) console.log(`Link: ${options.resetUrl}`);
      console.log('=============================\n');
    },
    async sendOTPEmail(email: string, otp: number) {
      console.log('\n=== EMAIL: OTP Login ===');
      console.log(`To: ${email}`);
      console.log(`OTP: ${otp}`);
      console.log('========================\n');
    },
    async sendLoginEmail(params: LoginEmailParams) {
      console.log('\n=== EMAIL: Sign-in ===');
      console.log(`To: ${params.to} (${params.brand})`);
      console.log(`Code: ${params.code}`);
      console.log(`Link: ${params.link}`);
      console.log('======================\n');
    },
    async sendLoginNotification(email: string, browserName: string, ip?: string) {
      console.log('\n=== EMAIL: Login Notification ===');
      console.log(`To: ${email}`);
      console.log(`Browser: ${browserName}`);
      console.log(`IP: ${ip || 'Unknown'}`);
      console.log('=================================\n');
    },
  };
}
