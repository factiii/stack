# Auth Rekey Spec

## Problem

When vault secrets are rekeyed (see `packages/stack/.spec/rekey.md`), `JWT_SECRET` must be rotated. Naively rotating JWT_SECRET invalidates every existing user session instantly — everyone gets logged out. This is disruptive and unnecessary if the compromise is limited to the vault password (not an active breach of user sessions).

## Goal

Support JWT_SECRET rotation with a graceful migration period so users aren't all force-logged-out simultaneously.

---

## Approach: Dual-Key Verification with Email Re-auth

### How It Works

1. **Rotate JWT_SECRET** — old secret becomes `JWT_SECRET_PREVIOUS`, new secret is `JWT_SECRET`
2. **Token verification tries new key first, falls back to old key**
3. **If token was signed with old key:**
   - Token is still valid (not expired, signature checks out against `JWT_SECRET_PREVIOUS`)
   - But user is flagged as "needs re-auth"
   - User can continue read-only / limited operations
   - User is forced to re-auth via their available 2FA method (email, authenticator, etc.)
   - On successful re-auth, issue new token signed with new key
4. **After migration window (configurable, default 7 days):**
   - Remove `JWT_SECRET_PREVIOUS`
   - All old tokens are now fully invalid
   - Users who haven't re-authed are logged out

### Migration Window Behavior

| Token State | Behavior |
|-------------|----------|
| New token | Full access |
| Old token (within window) | Forced re-auth via available 2FA, then issued new token |
| Old token (after window) | Rejected, full login required |

---

## TODO

### @factiii/auth Changes

- [ ] Add `JWT_SECRET_PREVIOUS` support to token verification middleware
- [ ] Dual-key verify: try `JWT_SECRET` first, fall back to `JWT_SECRET_PREVIOUS`
- [ ] Add `tokenGeneration` field (or similar) to decoded token payload to distinguish old vs new
- [ ] Add `needsReauth` flag/middleware for old-key tokens
- [ ] Force re-auth via available 2FA method when old-key token detected
- [ ] Config for migration window duration (`AUTH_REKEY_MIGRATION_DAYS`, default 7)
- [ ] Endpoint or cron to clear `JWT_SECRET_PREVIOUS` after migration window expires
- [ ] Tests for dual-key verification, re-auth flow, and window expiry

### @factiii/stack Integration

- [ ] `npx stack deploy --secrets rekey` step for JWT: generate new secret, move current to `JWT_SECRET_PREVIOUS` in vault
- [ ] Deploy both `JWT_SECRET` and `JWT_SECRET_PREVIOUS` to server env
- [ ] After migration window: remove `JWT_SECRET_PREVIOUS` from vault and redeploy
- [ ] Add `rekey-jwt-cleanup` scanfix that detects expired `JWT_SECRET_PREVIOUS` and prompts removal

### Refresh Token Handling

- [ ] On refresh with old-key token: issue new token signed with new key (seamless migration)
- [ ] On refresh with expired old-key token (past window): reject, force full login
- [ ] Mobile apps using refresh tokens migrate transparently within window

### Session Store (if applicable)

- [ ] If using server-side sessions: mark old sessions as "pending re-auth"
- [ ] Bulk session invalidation after migration window
- [ ] Admin UI to see migration progress (% users on new key)

---

## Edge Cases

- **User offline for entire migration window:** Logged out on return, must do full login. Acceptable.
- **Multiple rekeys in short succession:** Each rekey only keeps one `JWT_SECRET_PREVIOUS`. If rekeyed twice before window expires, tokens from the first key are immediately invalid. Document this — don't rekey more than once per migration window.
- **Mobile apps with long-lived tokens:** Refresh token flow handles this — app refreshes token on next API call, gets new-key token automatically.
- **2FA method:** Users are required to have at least one 2FA method. Re-auth uses whatever they have available.

## Out of Scope

- OAuth token rotation (Google, Apple) — those are provider-issued, not our tokens
- API key rotation for third-party integrations — separate concern
- Password rehashing — passwords aren't affected by JWT_SECRET rotation
