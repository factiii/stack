---
'@factiii/auth': patch
---

Declare `@trpc/server` as a peer dependency, not a regular one.

`createAuthRouter` returns a tRPC router the consumer merges into its own, and
the package throws `TRPCError` across twenty source files. Both sides must share
one `@trpc/server` instance, exactly as they must share one `zod`.

It was a regular dependency, and 0.20.2 bumped it from `^11.8.0` to `^11.18.0`.
Consumers on 11.8.x — which satisfied the old range and so deduped to a single
copy — no longer satisfy the new one, so pnpm nests a second `@trpc/server`
under the package. Two instances produce a type conflict on the tRPC internals:

    Property 'batchIndex' is missing in type
    '@trpc/server/...TRPCRequestInfoProcedureCall' but required in type
    '@factiii/auth/node_modules/@trpc/server/...TRPCRequestInfoProcedureCall'

The peer range is `>=11.0.0 <12`, which every tRPC 11 consumer satisfies, so
there is one copy again regardless of which 11.x they run. `@trpc/server` stays
in devDependencies so the package still builds and tests on its own.

This is the same class of bug as the zod dependency fixed in 0.20.1, found the
same way — by installing the published package into a real consumer rather than
copying a build into `node_modules`, which hides nesting.
