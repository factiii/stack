---
'@factiii/auth': patch
---

Ship `zod` as a peer dependency so consumers keep a single copy

`zod` was a regular dependency, so pnpm could install a second copy alongside
the consumer's. Two zod instances crash `createAuthRouter` at import — zod 4
reads `_zod.def` off schemas built by the other instance — and the failure
surfaces as `Cannot read properties of undefined (reading 'def')`, pointing at
zod internals rather than the cause. Consumers were pinning zod with a
`pnpm.overrides` entry to force one copy.

`peerDependenciesMeta` already declared `zod` non-optional; only the
`peerDependencies` half was missing. Consumers can now drop that override.
