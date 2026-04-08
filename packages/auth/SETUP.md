# AI Setup Guide for @factiii/auth

This file helps AI assistants (Copilot, Cursor, Claude, etc.) understand how to install and configure this package in a user's project.

## What this package does

`@factiii/auth` is a drop-in authentication library for tRPC apps. It provides pre-built auth routes — users do NOT need to write their own auth logic. It supports both **Prisma** and **Drizzle** as database ORMs.

## Choose your ORM

This library is ORM-agnostic via the `DatabaseAdapter` interface. Pick **one** of the two supported adapters:

### Option A: Prisma (recommended for existing Prisma projects)

```bash
npm install @factiii/auth @prisma/client superjson zod
npx @factiii/auth init
npx prisma generate
npx prisma db push
```

### Option B: Drizzle

```bash
npm install @factiii/auth drizzle-orm superjson zod
# Plus your Drizzle driver, e.g.:
npm install drizzle-orm/node-postgres pg
```

You do NOT need both — install only the ORM you use.

## Minimal integration

### With Prisma

```typescript
import { createAuthRouter, createPrismaAdapter } from '@factiii/auth';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const { router, authProcedure, t, createContext } = createAuthRouter({
  database: createPrismaAdapter(prisma),
  secrets: { jwt: process.env.JWT_SECRET! },
});

// Auth routes are already included in `router`
// Use `authProcedure` for protected routes:
const appRouter = t.mergeRouters(
  router,
  t.router({
    protectedRoute: authProcedure.query(({ ctx }) => {
      return { userId: ctx.userId };
    }),
  }),
);

export type AppRouter = typeof appRouter;
```

> **Backwards compatibility:** You can still pass `prisma` directly to the config and
> it will be auto-wrapped with `createPrismaAdapter()`. Using `database` explicitly is
> preferred for new projects.

### With Drizzle

```typescript
import { createAuthRouter, createDrizzleAdapter } from '@factiii/auth';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './db/schema';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool, { schema });

const { router, authProcedure, t, createContext } = createAuthRouter({
  database: createDrizzleAdapter(db, {
    users: schema.users,
    sessions: schema.sessions,
    otps: schema.otps,
    passwordResets: schema.passwordResets,
    devices: schema.devices,
    admins: schema.admins,
    // Optional: explicit join tables for many-to-many device relations
    // devicesToUsers: schema.devicesToUsers,
    // devicesToSessions: schema.devicesToSessions,
  }),
  secrets: { jwt: process.env.JWT_SECRET! },
});

const appRouter = t.mergeRouters(
  router,
  t.router({
    protectedRoute: authProcedure.query(({ ctx }) => {
      return { userId: ctx.userId };
    }),
  }),
);

export type AppRouter = typeof appRouter;
```

**Important:** Pass `{ schema }` to `drizzle()` so relational queries work.

## Required Drizzle schema tables

If using Drizzle, your schema must define these tables with matching column names:

Standard 2FA mode (the default) — TOTP secret + backup codes live on the user; no `Device` table, no per-session 2FA columns.

| Table            | Required columns |
|------------------|-----------------|
| `users`          | id, status, email, username, password, twoFaSecret, twoFaBackupCodes, oauthProvider, oauthId, tag, verifiedHumanAt, emailVerificationStatus, otpForEmailVerification, isActive |
| `sessions`       | id, userId, socketId, browserName, issuedAt, lastUsed, revokedAt |
| `otps`           | id, code, expiresAt, userId |
| `passwordResets` | id, createdAt, userId |
| `admins`         | userId, ip |

For the legacy device-mode flow (`features.twoFaMode: 'device'`), see `prisma/schema.device.prisma` — it adds a `Device` table, `Session.twoFaSecret`, `Session.deviceId`, and a `User.twoFaEnabled` flag, and you must additionally pass `createPrismaDeviceAdapter(prisma)` (or the Drizzle equivalent) as `deviceAuth` on `AuthConfig`.

## Required environment variables

```
JWT_SECRET=<random-string-at-least-32-chars>
DATABASE_URL=<your-database-connection-string>
```

## What `createAuthRouter` provides automatically

These tRPC procedures are ready to use — no additional code needed:

- `register` - User signup
- `login` - Email/username + password login
- `logout` - End session
- `refresh` - Refresh JWT token
- `changePassword` - Change password (authenticated)
- `sendPasswordResetEmail` - Request password reset
- `checkPasswordReset` - Validate reset token
- `resetPassword` - Complete password reset
- `endAllSessions` - Logout everywhere
- `enableTwofa` / `disableTwofa` / `getTwofaSecret` - 2FA management
- `twoFaReset` / `twoFaResetVerify` - 2FA recovery
- `oAuthLogin` - Google/Apple OAuth
- `sendVerificationEmail` / `verifyEmail` - Email verification
- `verifyBiometric` / `registerPushToken` / `deregisterPushToken` - Biometric auth

## Optional configuration

```typescript
createAuthRouter({
  database: createPrismaAdapter(prisma), // or createDrizzleAdapter(db, tables)
  secrets: { jwt: process.env.JWT_SECRET! },

  // Toggle features
  features: {
    twoFa: true,
    oauth: { google: true, apple: true },
    emailVerification: true,
    passwordReset: true,
    biometric: false,
  },

  // Custom email sending
  emailService: {
    sendVerificationEmail: async (email, code) => { /* your email logic */ },
    sendPasswordResetEmail: async (email, token) => { /* your email logic */ },
    sendOTPEmail: async (email, otp) => { /* your email logic */ },
  },

  // Token timing
  tokenSettings: {
    jwtExpiry: 30 * 24 * 60 * 60, // 30 days (seconds)
    passwordResetExpiryMs: 60 * 60 * 1000, // 1 hour
  },

  // Lifecycle hooks
  hooks: {
    onUserCreated: async (userId, input) => { /* custom logic */ },
    onUserLogin: async (userId, sessionId) => { /* custom logic */ },
    onSessionRevoked: async (sessionId, socketId, reason) => { /* custom logic */ },
  },

  // OAuth keys (required if oauth features enabled)
  oauthKeys: {
    google: { clientId: process.env.GOOGLE_CLIENT_ID! },
    apple: { clientId: process.env.APPLE_CLIENT_ID! },
  },
});
```

## Prisma schema

Running `npx @factiii/auth init` copies the required Prisma schema. The key models are: `User`, `Session`, `Admin`, `PasswordReset`, `OTP`, `Device`. Merge these into your existing schema if you have one.

## Verify setup

```bash
npx @factiii/auth doctor
```

This checks for common issues. It auto-detects whether you're using Prisma, Drizzle, or both, and runs the appropriate checks:

- **Prisma:** Verifies schema files exist with required models, enums, and fields
- **Drizzle:** Verifies config file, schema file, and required table definitions
- **Both:** Runs all checks for both ORMs
