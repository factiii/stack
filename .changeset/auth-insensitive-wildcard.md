---
'@factiii/auth': patch
---

Security: case-insensitive email and username lookups are now exact. The Prisma adapter escapes the characters that a case-insensitive database match treats as patterns, and sign-in, OAuth attach-by-email, signup checks, password reset, 2FA reset and login-method lookups re-check that the account found has the same email or username as the one given. Upgrade is recommended for every consumer of the Prisma adapter.
