---
'@factiii/auth': minor
---

Email sign-in with a link and a code, and one 2FA gate for every sign-in path

`auth.emailLogin.request`, `verifyLink` and `verifyCode`, behind
`features.emailLogin`. One email carries a sign-in link and a 6-digit code for the
same attempt. `request` returns `{ sent: true }` with the same timing whether or
not an account exists, so it cannot be used to find out who has one; the email is
sent without being awaited, so a slow or failing mail provider changes neither the
timing nor the response. An attempt lives 15 minutes, is consumed once and
atomically by whichever of the link or the code arrives first, allows five wrong
codes, and is replaced by a newer request. Requests are limited per address and IP
pair, per IP, and per address, with the per-address cap higher than the pair limit
so a stranger cannot use up the owner's requests from one IP. Only a hash of the
token and an HMAC of the code are stored. Verifying an address with no account
creates one with the email already VERIFIED; an existing account whose email was
never proven is refused, by the same rule as the OAuth attach fix. `app` is a key
into a server-side allowlist (`emailLogin.apps`, own keys only), which picks the
link host and brand, so no URL ever comes from the client. Needs the new
`EmailLoginAttempt` model, `emailLogin.pepper`, `emailLogin.rateLimit`, and
`emailService.sendLoginEmail`; `createAuthConfig` refuses to start without them.

The 2FA check now runs at every place a session is minted, not only password
login. A magic link or an OAuth sign-in into an account with 2FA on used to go
straight through; both now return `pendingLogin` or `requires2FA` exactly as
password login does, and accept `twoFaCode` for the second step. Push approval
for these paths goes through the new `hooks.onDeviceStepRequired`. A
user-verified passkey still signs in alone. The second step is bounded: through
`emailLogin.rateLimit`, an account accepts ten second-step codes per 15 minutes
across every IP, five wrong codes spend the email attempt or magic link they came
with, and two requests racing on one link or attempt push a device once.

New `hooks.beforeSessionMint(userId, { firstFactor, ip })` runs at every mint site
— password, email sign-in, magic link, OAuth (before a provider is linked to an
existing account) and passkey — before the second step and any side effect.
Throw to refuse. Account-status rules kept in `beforeLogin` only ever covered
password login; move them here (for example, refusing a DELETED account past its
grace window). The package itself now refuses DEACTIVATED and BANNED accounts on
every path, including magic link and passkey, which did not check.

Case-insensitive user lookups are exact. The Prisma adapter's `mode:
'insensitive'` `equals` is an ILIKE on Postgres, where `_` and `%` are wildcards,
so a lookup for `j_hn@outlook.com` could return `john@outlook.com` — and OAuth
attach-by-email, email sign-in and password reset act on that result. Lookups now
escape the wildcards and keep only a row with the same identifier, and those
paths re-check the address before acting on it.

`verifyMagicLink` is single-use atomically: two requests racing on one link can
no longer both sign in. Adapters gain `magicLink.consume`; one written before it
keeps the old read-then-mark behaviour.

`sendPasswordResetEmail` takes an optional `app` key and passes the app's reset
URL to the email service, so each product's reset link opens on its own site.

`auth.emailLogin.peekLink({ token })` returns `{ valid: true, maskedEmail }` for an
open link (`a•••@example.com`, from the exported `maskEmail`), or `{ valid: false }`,
so a confirm page can name the address before anyone signs in. It is a mutation,
so a link pre-fetch never calls it; it spends nothing and is limited per IP.

Accounts created by email sign-in or OAuth try a fresh generated username when the
one they drew is taken, up to five times, instead of failing. Only an email
violation still counts as a lost race for the same inbox. The default
`generateUsername` now adds a random suffix, so two accounts made in the same
millisecond do not draw the same name.
