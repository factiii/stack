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

1. **Make changes** on a feature branch
2. **Add a changeset** describing what changed:
   ```bash
   pnpm changeset
   ```
   This prompts you to pick which packages changed (`@factiii/stack`, `@factiii/auth`, or both) and the semver bump type (patch/minor/major). It creates a markdown file in `.changeset/` — commit it with your PR.

3. **Open a PR to `main`** — CI runs build, test, typecheck, and verifies a changeset exists

4. **Merge the PR** — the Release workflow detects pending changesets and auto-creates a **"chore: version packages"** PR that bumps versions and updates changelogs

5. **Merge the version PR** — packages are automatically built and published to npm

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
