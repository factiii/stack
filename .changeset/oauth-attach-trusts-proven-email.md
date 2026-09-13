---
'@factiii/auth': patch
---

Only attach an OAuth sign-in to an existing account by an email that was proven

`oAuthLogin` attaches a new Google or Apple identity to an existing passwordless
account whose email matches the provider's. Two things let that attach land on
the wrong account.

The email could come from the client. When Apple's signed token carried no
email claim, the verifier fell back to `user.email` from the request, so anyone
holding a valid Apple token for their own Apple ID could name another person's
address and be signed into that person's passwordless account. The Google branch
trusted `payload.email` without checking `email_verified`. The verifier now takes
the email only from the signed token, and from Google only when it is marked
verified. A token with no trusted email still verifies — an identity already
linked by its subject keeps signing in — but it can no longer attach or create.
`OAuthResult.email` is now optional to say so.

And the account's own email did not have to be proven. A consumer that lets a
user store an unclaimed address unverified is open to pre-hijacking: register a
passwordless account under a victim's address, and the victim's first genuine
sign-in lands in an account the registrant still controls. No token is forged
for that one. Attach-by-email now requires the matching account's
`emailVerificationStatus` to be `VERIFIED`, and refuses otherwise; the user can
still link the provider from a signed-in session. An adapter that does not return
the field refuses every attach rather than allowing any.
