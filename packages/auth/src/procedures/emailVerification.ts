import { randomUUID, timingSafeEqual } from 'node:crypto';

import { TRPCError } from '@trpc/server';

import { type AuthProcedure } from '../types/trpc';
import type { ResolvedAuthConfig } from '../utilities/config';
import { verifyEmailSchema } from '../validators';

/** Factory for email verification procedures. */
export class EmailVerificationProcedureFactory {
  constructor(
    private config: ResolvedAuthConfig,
    private authProcedure: AuthProcedure
  ) {}

  createEmailVerificationProcedures() {
    return {
      sendVerificationEmail: this.sendVerificationEmail(),
      verifyEmail: this.verifyEmail(),
      getVerificationStatus: this.getVerificationStatus(),
    };
  }

  private checkConfig() {
    if (!this.config.features.emailVerification) {
      throw new TRPCError({ code: 'NOT_FOUND' });
    }
  }

  private sendVerificationEmail() {
    return this.authProcedure.mutation(async ({ ctx }) => {
      this.checkConfig();
      const { userId } = ctx;

      const user = await this.config.database.user.findActiveById(userId);

      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      if (user.emailVerificationStatus === 'VERIFIED') {
        return { message: 'Email is already verified', emailSent: false };
      }

      const otp = randomUUID();

      await this.config.database.user.update(userId, {
        emailVerificationStatus: 'PENDING',
        otpForEmailVerification: otp,
      });

      if (this.config.emailService) {
        try {
          await this.config.emailService.sendVerificationEmail(user.email, otp);
          return { message: 'Verification email sent', emailSent: true };
        } catch {
          return { message: 'Failed to send email', emailSent: false };
        }
      }

      return { message: 'Email service not configured', emailSent: false };
    });
  }

  private verifyEmail() {
    return this.authProcedure.input(verifyEmailSchema).mutation(async ({ ctx, input }) => {
      this.checkConfig();
      const { userId } = ctx;
      const { code } = input;

      const user = await this.config.database.user.findActiveById(userId);

      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      if (user.emailVerificationStatus === 'VERIFIED') {
        return { success: true, message: 'Email is already verified' };
      }

      if (
        !user.otpForEmailVerification ||
        !timingSafeEqual(Buffer.from(code), Buffer.from(user.otpForEmailVerification))
      ) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid verification code' });
      }

      await this.config.database.user.update(userId, {
        emailVerificationStatus: 'VERIFIED',
        otpForEmailVerification: null,
      });

      if (this.config.hooks?.onEmailVerified) {
        await this.config.hooks.onEmailVerified(userId);
      }

      return { success: true, message: 'Email verified' };
    });
  }

  private getVerificationStatus() {
    return this.authProcedure.query(async ({ ctx }) => {
      this.checkConfig();
      const { userId } = ctx;

      const user = await this.config.database.user.findById(userId);

      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      return {
        email: user.email,
        status: user.emailVerificationStatus,
        isVerified: user.emailVerificationStatus === 'VERIFIED',
      };
    });
  }
}
