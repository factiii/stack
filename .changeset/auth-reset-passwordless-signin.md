---
'@factiii/auth': patch
---

A password reset requested for an account with no password now sends an email sign-in (link and code) when the request names an app with email sign-in, instead of refusing. The sign-in goes through the same path as `auth.emailLogin.request`, so it shares its rate limits and single open attempt.

`sendPasswordResetEmail` now gives one answer for every address — `{ message: 'If an account exists with that email, we sent a link.' }` — padded to the email sign-in response floor. It no longer returns different messages or errors for an address with no account, an account with no password, or an account with no email, and a reset email the provider rejects is logged instead of thrown. An unknown `app` key is still refused with `Unknown app.`
