---
'@factiii/auth': patch
---

Build against zod 4, so the emitted types match the declared peer range.

`peerDependencies` has always said `zod >=4.3.6 <5`, but a `zod: 3.25.76`
override in the workspace forced zod 3 into the build. The package compiled and
tested green while emitting zod 3 shapes — `z.ZodObject<..., "strip",
z.ZodTypeAny, ...>` — into the published `.d.ts`, which do not typecheck for a
consumer on zod 4.

`validators.ts`, `types/hooks.ts` and `procedures/passkey.ts` imported
`AnyZodObject`, which zod 3 exported and zod 4 removed. `src/types/zod.ts` now
defines the zod 4 equivalent, the override is gone, and auth builds against zod
4.5.4 with a clean `.d.ts`.

Consumers already on the declared zod 4 get a fix. A consumer whose `zod`
resolves to v3 was outside the peer range already and needs to move to zod 4 —
`createAuthRouter` throws `merging._def.shape is not a function` at startup when
it merges `schemaExtensions` built by a different zod major.

Also drops the unused `better-sqlite3` dependency, its adapter and its types,
which removes a native build step from install.
