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

## Browser Session Detection

`@factiii/auth/browser` is a Node-free entry point for client bundles. It answers "does this browser hold a session?" from the client-readable `auth-client` cookie, so the app can decide whether to run its `users.me` probe — no separate `localStorage` marker with a different lifetime than the cookie.

```typescript
import { hasClientSession, readClientSession } from '@factiii/auth/browser';

if (hasClientSession()) {
  await trpc.users.me.query();
}

const session = readClientSession(); // { userId, updatedAt, ...custom } | null
```

Both take optional `{ clientToken, cookie }` — `clientToken` for a custom `storageKeys.clientToken`, `cookie` to pass a cookie string during SSR instead of reading `document.cookie` (no `document` means `false`/`null`).

The signature is **not** verified — that would need the JWT secret, which must never reach the browser. Treat the result as a presence hint, not proof of identity: a forged cookie buys one `users.me` probe that 401s.

### Split-host deployments

`cookieSettings.domain` is unset by default, making both cookies host-only — so an app on `example.com` cannot see a cookie set by `api.example.com`, and local dev hides it because both sit on `localhost` (cookies ignore port). Set `clientDomain` to scope the client cookie to the parent domain and leave `domain` unset so the session JWT stays host-only on the API:

```typescript
cookieSettings: {
  clientDomain: '.example.com', // presence hint: readable on example.com
  // domain: unset            → httpOnly session JWT stays on api.example.com
}
```

Do **not** reach for `domain` to solve this — it applies to both cookies and would broadcast the httpOnly session JWT to every subdomain.

`clientDomain` widens who can read the client cookie's payload (`userId`, `updatedAt`, plus anything you add in `getClientCookiePayload`) to every subdomain of the value you set, so keep that payload non-sensitive. The httpOnly token is unaffected.

## Procedures

Auth procedures: `register`, `login`, `logout`, `refresh`, `changePassword`, `setPassword`, `resetPassword`, `oAuthLogin`, `oAuthLink`, `oAuthUnlink`, `enableTwofa`, `disableTwofa`, `sendVerificationEmail`, `verifyEmail`, `passkey.*`, and more. See [Multi-method accounts](#multi-method-accounts-passkeys--linked-providers).

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

## Multi-method accounts (passkeys + linked providers)

One account can hold a password, several passkeys, and both Google and Apple. All additive and opt-in — implement the storage hooks and the matching procedures light up; omit them and behavior is unchanged (single provider, single scalar).

**Passkeys** (`features.passkey`): `auth.passkey.registerOptions` / `registerVerify` create a new account; `auth.passkey.addOptions` / `addVerify` / `list` / `remove` manage a signed-in account's credentials. The package runs the WebAuthn ceremony; you own storage via the **`passkey` adapter** (`config.passkey`, like `deviceAuth`):

```typescript
// PasskeyAdapter
storeChallenge, consumeChallenge, createUser, resolveCredential,
onAuthenticated, has, list, add, remove
```

**Linked OAuth providers** — the **`oauthAccounts` adapter** (`config.oauthAccounts`) lets `auth.oAuthLink` / `auth.oAuthUnlink` attach/detach providers, and `oAuthLogin` resolve any linked provider:

```typescript
// OAuthAccountAdapter
resolve, link, unlink, list
```

When `oauthAccounts` is provided, `resolve` is the source of truth for OAuth sign-in, so `oAuthLogin` no longer rejects a token whose provider differs from the legacy `User.oauthProvider` scalar. Keep the scalar as the primary/creation provider (mirror it into the link table) for backwards compatibility.

**Add a password** to a passwordless (passkey/OAuth) account: `auth.setPassword` — no adapter, it uses the User adapter.

**Prisma? Skip the boilerplate.** Like `createPrismaDeviceAdapter`, the package ships prebuilt Prisma adapters — the credential/link CRUD is generic, so you only wire the app-specific bits:

```ts
import {
  createPrismaOAuthAccountAdapter,
  createPrismaPasskeyAdapter,
} from '@factiii/auth';

createAuthRouter({
  // ...
  oauthAccounts: createPrismaOAuthAccountAdapter(prisma), // fully generic
  passkey: createPrismaPasskeyAdapter(prisma, {
    createUser: async (input) => { /* your user creation + provisioning */ },
    challenge: { storeChallenge, consumeChallenge }, // e.g. Redis with a TTL
  }),
});
```

The `Passkey` and `OAuthAccount` Prisma models ship in the reference schemas (`prisma/schema.*.prisma`). Every unlink/remove is guarded so an account never loses its last sign-in method; `countLoginMethods`, `assertKeepsLoginMethod` and `resolveLoginMethods` are exported (the last drives a username-first login screen).

## CLI

```bash
npx @factiii/auth init     # Copy Prisma schema to your project
npx @factiii/auth schema   # Print schema path for manual copying
npx @factiii/auth doctor   # Check setup for common issues
npx @factiii/auth help     # Show help
```

## License

MIT
