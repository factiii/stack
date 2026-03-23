# Building @factiii/stack

Monorepo containing two npm packages:
- `@factiii/stack` — Infrastructure CLI (root)
- `@factiii/auth` — Authentication library (`packages/auth/`)

## Prerequisites

- Node.js >= 18
- pnpm

## Install

```bash
pnpm install
```

## Build

```bash
# Stack only
pnpm build

# Auth only
pnpm build:auth

# Both
pnpm build:all
```

## Test

```bash
# Stack only
pnpm test

# Auth only
pnpm test:auth

# Both
pnpm test:all
```

## Typecheck

```bash
pnpm typecheck
```

## Releasing (Changesets)

This repo uses [changesets](https://github.com/changesets/changesets) for versioning and npm publishing. CI/CD handles everything automatically.

### How it works

```
feature PR → merge to main → version PR auto-created → merge version PR → npm publish
                                    ↑
                        (this is your release gate)
```

1. **Make changes** on a feature branch
2. **Run `pnpm changeset`** — pick which package(s) changed and bump type (patch/minor/major). Commit the generated file with your PR.
3. **Open PR to `main`** — CI runs build, test, typecheck, and verifies a changeset exists
4. **Merge PR** — a **"chore: version packages"** PR is auto-created with bumped versions and updated changelogs
5. **Merge the version PR when you're ready to release** — npm publish happens automatically

**Not every PR triggers a publish.** The version PR is the release gate — you control when to merge it. Multiple PRs can batch up: if you merge 3 PRs before merging the version PR, all changesets combine into one version bump.

### Commands

| Command | What it does |
|---------|-------------|
| `pnpm changeset` | Add a changeset (run during development) |
| `pnpm version-packages` | Apply pending changesets (CI does this) |
| `pnpm release` | Build all + publish to npm (CI does this) |

### Skipping a changeset

For PRs that don't need a release (docs, CI config, etc.):
```bash
pnpm changeset --empty
```

### Setup required (one-time)

1. Add an `NPM_TOKEN` secret to your GitHub repo (Settings > Secrets > Actions)
   - Generate at npmjs.com > Access Tokens > Granular Access Token
   - Needs publish permission for `@factiii/stack` and `@factiii/auth`
2. Enable branch protection on `main` requiring the CI check to pass

## Local Testing

Link stack globally for testing in app repos:

```bash
pnpm link --global
# Then in your app repo:
pnpm link --global @factiii/stack
```
