---
'@factiii/stack': patch
---

Load the AWS SDK only when an AWS code path runs.

`aws-helpers.ts` imported all nine `@aws-sdk/client-*` packages at module
scope. Every AWS scanfix file imports that helper, and `factiii/index.ts`
imports those scanfix files to build its `fixes` array, so requiring any CLI
command pulled the whole SDK in. That cost about 100 ms on every invocation,
including `--help`, `ops`, `db` and `backup`, which never touch AWS.

The SDK types are now `import type` — TypeScript erases those — and nine
`*Sdk()` accessors require the real packages on first use and cache them. Call
sites construct commands through the accessor, so the SDK loads only when a fix
actually provisions infrastructure.

`node bin/stack --help` drops from 140 ms to 50 ms, and the AWS SDK module
count at startup drops from 24 to 0.
