# @factiii/auth

Drop-in authentication for tRPC. JWT sessions, OAuth, 2FA—all type-safe.

## Install

```bash
npm install @factiii/auth @prisma/client
```

## Setup

**1. Add Prisma models:**

```bash
npx @factiii/auth init
npx prisma generate && npx prisma db push
npx @factiii/auth doctor  # Verify setup
```

**2. Create auth router:**

```typescript
import { createAuthRouter } from '@factiii/auth';
import { prisma } from './prisma';

export const { router, authProcedure, createContext } = createAuthRouter({
  prisma,
  secrets: { jwt: process.env.JWT_SECRET! },
});
```

**3. Use protected routes:**

```typescript
const protectedRouter = router({
  getProfile: authProcedure.query(({ ctx }) => {
    return { userId: ctx.userId };
  }),
});
```

## Config

```typescript
createAuthRouter({
  prisma,
  secrets: { jwt: 'your-secret' },

  // Optional
  features: {
    emailVerification: true,
    twoFa: true,
    oauth: { google: true, apple: true },
    biometric: false,
  },
  oauthKeys: {
    google: { clientId: '...' },
    apple: { clientId: '...' },
  },
  emailService: {
    sendVerificationEmail: async (email, code) => {},
    sendPasswordResetEmail: async (email, token) => {},
    sendOTPEmail: async (email, otp) => {},
  },
  hooks: {
    onUserCreated: async (userId) => {},
    onUserLogin: async (userId, sessionId) => {},
    // ... 15+ lifecycle hooks
  },
  tokenSettings: {
    jwtExpiry: 2592000,                  // JWT expiry in seconds (default: 30 days)
    passwordResetExpiryMs: 3600000,    // Reset token expiry (default: 1 hour)
    otpValidityMs: 900000,             // OTP validity window (default: 15 minutes)
  },
});
```

## Upgrading to v0.6.0

v0.6.0 includes security hardening. See the breaking changes below and how to migrate.

### Breaking Changes

**1. Auth cookie is now `httpOnly` by default**

The auth token cookie is no longer readable by client-side JavaScript. The token is sent automatically by the browser on every request — no client-side access needed.

Sessions are automatically slid forward: the authGuard re-issues a fresh token whenever the current one is older than 24 hours, so active users stay logged in indefinitely.

**Migration — if your client reads `document.cookie` to get the auth token:**

Remove any client-side code that reads or parses the auth token from `document.cookie`. The browser handles sending it automatically. If you were reading the token for refresh timing, you no longer need to — the server handles it.

If you need the old behavior, explicitly opt out:

```typescript
createAuthRouter({
  cookieSettings: { httpOnly: false },
  // ...
});
```

**2. Minimum password length increased from 6 to 8 characters**

Affects `signupSchema`, `resetPasswordSchema`, and `changePasswordSchema`. Existing users with 6-7 character passwords can still log in but cannot set new passwords shorter than 8 characters.

**3. JWT algorithm explicitly pinned to HS256**

`jwt.sign()` and `jwt.verify()` now specify `algorithm: 'HS256'` / `algorithms: ['HS256']`. This is what jsonwebtoken defaults to, so no action needed unless you were using a different algorithm.

**4. TOTP secrets use `crypto.randomBytes()` instead of `Math.random()`**

No migration needed. New secrets are cryptographically secure. Existing secrets remain valid.

**5. Email verification uses timing-safe comparison**

No migration needed. Drop-in security improvement.

## Auth Approach

Rolling-window JWT. A single token is stored in an HTTP cookie. Calling `refresh` re-issues it with a fresh expiry (default: 30 days), sliding the session forward for active users.

## Procedures

Auth procedures: `register`, `login`, `logout`, `refresh`, `changePassword`, `resetPassword`, `oAuthLogin`, `enableTwofa`, `disableTwofa`, `sendVerificationEmail`, `verifyEmail`, and more.

## Lifecycle Hooks

```typescript
interface AuthHooks {
  // Registration & Login
  beforeRegister?: (input) => Promise<void>;
  beforeLogin?: (input) => Promise<void>;
  onUserCreated?: (userId, input) => Promise<void>;
  onUserLogin?: (userId, sessionId) => Promise<void>;

  // Sessions
  onSessionCreated?: (sessionId) => Promise<void>;
  onSessionRevoked?: (sessionId, socketId, reason) => Promise<void>;
  afterLogout?: (userId, sessionId, socketId) => Promise<void>;
  onRefresh?: (userId) => Promise<void>;

  // Security
  onPasswordChanged?: (userId) => Promise<void>;
  onEmailVerified?: (userId) => Promise<void>;
  onTwoFaStatusChanged?: (userId, enabled) => Promise<void>;
  onOAuthLinked?: (userId, provider) => Promise<void>;
  onBiometricVerified?: (userId) => Promise<void>;
  getBiometricTimeout?: () => Promise<number | null>;
}
```

## CLI

```bash
npx @factiii/auth init     # Copy Prisma schema to your project
npx @factiii/auth schema   # Print schema path for manual copying
npx @factiii/auth doctor   # Check setup for common issues
npx @factiii/auth help     # Show help
```

## License

MIT
