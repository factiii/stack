---
'@factiii/auth': patch
---

Stop logging a CRITICAL SECURITY error for requests with no auth token — a missing token is normal anonymous/logged-out traffic, not a security event. Cookies are still cleared and UNAUTHORIZED is still thrown. Also removes the doubled "Session revoked: Session revoked:" prefix from revocation log descriptions, and prepends the tRPC procedure path to errorFormatter SERVER_ERROR stacks so minified production errors are attributable to a procedure.
