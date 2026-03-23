# Security & Compatibility Audit

## Purpose
Track `pnpm audit` vulnerabilities and pnpm overrides for `@factiii/auth`.

## Process
1. Remove ALL overrides from `package.json`
2. `pnpm install --no-frozen-lockfile`
3. `pnpm audit` — note what's vulnerable
4. For each vuln: `pnpm why <pkg>` — if upstream fixed it, no override needed
5. Add security overrides only for transitive deps where the fix is a semver-compatible bump
6. `pnpm install && pnpm audit` — verify
7. Update tables below with results

**Don't override** if: major version jump required, dev-only with no prod exposure, or it's a direct dep (just upgrade it).

## Current Security Overrides (2026-03-18)

| Package | Override | Source chain | Why |
|---------|----------|-------------|-----|
| `hono` | `>=4.12.7` | prisma → @prisma/dev → hono | Prototype pollution + XSS + cache deception |
| `@hono/node-server` | `>=1.19.10` | prisma → @prisma/dev → @hono/node-server | Request smuggling via Static Middleware |
| `minimatch` | `>=9.0.7` | eslint → minimatch, @typescript-eslint → minimatch | ReDoS (2 CVEs) |
| `lodash` | `>=4.17.23` | prisma → @prisma/dev → chevrotain → lodash | Prototype pollution in unset/omit |
| `flatted` | `>=3.4.0` | eslint → file-entry-cache → flat-cache → flatted | Unbounded recursion DoS in parse() |
| `rollup` | `>=4.59.0` | tsup → rollup | Arbitrary file write via path traversal |
| `ajv` | `>=6.14.0` | eslint → ajv | ReDoS when using `$data` option |

## Unfixable (need upstream updates)
- **esbuild** (moderate): tsup → esbuild. Dev-only build tool, no prod exposure.

## Dev-Only Note
All current vulnerabilities are in devDependencies (eslint, tsup, prisma CLI). The published package (`dist/`, `bin/`, `prisma/`) does not ship any of these transitive dependencies to consumers.

## Removed Overrides
_(none yet — first audit)_
