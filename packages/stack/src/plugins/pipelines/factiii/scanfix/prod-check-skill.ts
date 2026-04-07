/**
 * prod-check skill scanfix for Factiii Pipeline plugin
 *
 * Ensures the per-user Claude Code skill at ~/.claude/skills/prod-check/SKILL.md
 * exists on the developer's machine. The skill encodes the pre-production
 * verification workflow (detect repo shape → lint → check-types → tests → build
 * → diff vs production → secret scan → audit → auto-commit fixes) so any
 * Claude Code session in any factiii-pipeline repo can run it consistently.
 *
 * The SKILL.md is intentionally generic across factiii-pipeline repos: it lives
 * once at ~/.claude/skills/prod-check/SKILL.md and is shared by every repo on
 * the machine, so it must detect repo shape at runtime (apps/server, apps/mobile,
 * Prisma, etc.) rather than hardcoding paths from any one repo.
 *
 * Local-only (no SSH, no GITHUB_ACTIONS check). Stage: dev.
 * Severity: warning — missing skill doesn't break deploys, but having it
 * available is what enforces the pre-prod gates the team relies on.
 *
 * OPT-IN: This scanfix is a "host-machine fix" — it writes to ~/.claude/, which
 * is the developer's personal Claude Code config, not project state. Per
 * STANDARDS.md "Host-Machine Fixes", these are gated behind an explicit
 * opt-in in stack.local.yml (`claude_skills: true`). When the flag is unset
 * or false, scan returns "no issue" and fix is a no-op. This keeps devs who
 * don't use Claude Code (or who curate their own skills) from being surprised
 * by files appearing in their home directory.
 *
 * Split of concerns:
 *   - This scanfix owns the skill *workflow* (SKILL.md). Process lives here
 *     so it ships with stack and is identical on every dev machine that
 *     opts in.
 *   - The audit *override reference table* (which packages, why) is optional
 *     per-repo at .specs/audit.md so PR reviewers can see it; the skill uses
 *     it if present and skips it if not.
 *   - Phase 4 of the SKILL.md auto-commits the deterministic fixes the gate
 *     produced. This is a sanctioned exception to factiii-stack's
 *     "never commit without approval" rule because prod-check is itself an
 *     explicit user-invoked gate; the skill always reports the resulting
 *     commit SHA back to the user.
 *
 * If the user edits their local SKILL.md, this scanfix won't clobber it —
 * delete the file and re-run `npx stack fix --dev` to restore the canonical
 * version.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Fix } from '../../../../types/index.js';
import { loadLocalConfig } from '../../../../utils/config-helpers.js';

const SKILL_DIR = path.join(os.homedir(), '.claude', 'skills', 'prod-check');
const SKILL_FILE = path.join(SKILL_DIR, 'SKILL.md');

const SKILL_CONTENT = `---
name: prod-check
description: Pre-production verification for any factiii-pipeline repo. Runs quality gates (lint, types, tests, build), diffs the current branch against origin/production for schema/migration/env/secret/API changes, runs a security audit, and commits the resulting fixes. TRIGGER when the user asks to check a branch against production, prepare a production push, run pre-merge checks, or audit dependencies before release.
---

# prod-check

Pre-production verification workflow for **factiii-pipeline repos**. Runs in four phases: **fix everything locally**, **diff against production**, **security audit**, then **commit**. Report at the end groups findings as **BLOCKING** vs **INFORMATIONAL**.

The whole point: nothing should reach \`origin/production\` that hasn't passed local quality gates and been reviewed for schema, secret, and API-breaking changes.

This skill is installed once globally in \`~/.claude/skills/\` and is shared by every factiii-pipeline repo on your machine. Repo layouts vary — **detect what exists before running step-specific commands**. Skip steps that don't apply (e.g. no \`apps/mobile\` → no Expo doctor; no Prisma schema → no migration diff). Never invent paths.

---

## Phase 0 — Detect repo shape

Before running anything, inspect the working directory and record which of these exist. Every later phase branches on this list:

- \`apps/server\` (Node server app)
- \`apps/client\` (web client)
- \`apps/mobile\` (Expo mobile app)
- \`apps/server/prisma/schema.prisma\` and \`apps/server/prisma/migrations/\`
- \`apps/server/src/routes/\` (tRPC route tree)
- \`shared/\` or \`packages/shared/\` validator dir (look for \`validators/\` underneath)
- \`.specs/audit.md\` (audit override reference table — optional)
- Root scripts: which of \`lint:fix\`, \`lint\`, \`check-types\`, \`test\`, \`build\` exist in root \`package.json\`

If a repo has only a server, run only server steps. If it has no Prisma, skip schema/migration diffing. **Do not fail a phase because an optional path is missing — note it as "n/a for this repo" and move on.**

---

## Phase 1 — Local quality gates (fix before continuing)

Run in this order against the scripts that exist. Each step must be green before moving on. If a step fails, fix it (or report blockers and stop) — do not skip.

1. **Sync** — \`git fetch origin production\` and confirm the working tree is clean (\`git status\`). Stash or commit anything dirty before continuing; uncommitted state contaminates the diff in Phase 2.
2. **Auto-fix lint noise** — \`pnpm lint:fix\` if the script exists. This cleans import order, unused imports, prettier, prefer-const so the type/test output isn't drowned in cosmetic churn. Always run the fixer first; ignore auto-fixable categories as *findings*.
3. **Type check** — \`pnpm check-types\`. Fix every error. No \`@ts-ignore\`, no \`any\` (use \`unknown\`). Type errors are blocking.
4. **Lint (real rules)** — \`pnpm lint\`. Focus on what matters: promise handling, hooks rules, real type issues. Auto-fixable categories are noise — don't chase them.
5. **Server tests** — if \`apps/server/\` exists, from there run \`pnpm seed:test\` first (if defined), then \`pnpm test\`. The seed step is required for repos that have it; skipping it produces misleading failures.
6. **Build everything that exists** — \`pnpm build\` from the root. All present apps must build. A green local dev does not imply a green build.

If any step surfaces failures you can fix safely, fix them. If failures need user judgment (e.g. a failing test reflects intended behavior change), stop and report before continuing.

---

## Phase 2 — Diff against production

Only run after Phase 1 is fully green. Use \`origin/production\` as the base (refresh with \`git fetch origin production\` if Phase 1 took a while). For every path-based check below, only run it if the path exists in this repo.

1. **Overall diffstat** — \`git diff --stat origin/production...HEAD\` for orientation.
2. **Schema & migrations** — only if \`apps/server/prisma/schema.prisma\` exists. \`git diff origin/production...HEAD -- apps/server/prisma/schema.prisma 'apps/server/prisma/migrations/**'\`.
   - Comment-only schema changes = informational.
   - Field/model/index changes = blocking unless paired with a migration.
   - **New migration files = blocking action**: they need to be applied to prod DB during deploy. Call this out explicitly with the migration name(s).
3. **Secrets scan** — always. Search the diff for committed credentials. Patterns to grep: \`AKIA[0-9A-Z]{16}\` (AWS access key), \`-----BEGIN .* PRIVATE KEY-----\`, \`sk_live_\`, \`sk_test_\`, \`xox[baprs]-\`, \`ghp_\`, \`Bearer [A-Za-z0-9_\\-]{20,}\`, raw \`password\\s*[:=]\`, \`client_secret\`. Run against \`git diff origin/production...HEAD\`. Anything matching is **BLOCKING** — instruct the user to rotate the credential in its provider before merging, since git history is forever.
4. **Env / infra surface** — diff whichever of these exist and flag any change:
   - \`stack.yml\`, \`stackAuto.yml\`, \`docker-compose*.yml\`
   - \`.github/workflows/**\`
   - \`start.sh\`, root \`package.json\`, any \`apps/*/package.json\` (deps)
   - \`pnpm-workspace.yaml\` catalog
   Changes here often need a corresponding action on the prod host (env var added, image rebuilt, workflow secret set).
5. **Breaking API changes for mobile** — only if \`apps/mobile/\` exists. Old mobile builds in the wild cannot be force-updated. Diff the server's route tree (e.g. \`apps/server/src/routes/**\`) and look for:
   - Removed tRPC procedures
   - Renamed/removed input or output fields
   - Tightened Zod validators (new required fields, narrower enums)
   - Changed HTTP status codes or error shapes
   These are blocking unless the change is additive or behind a version gate.
6. **Shared validators** — if a shared validator dir exists, diff it. Tightening a Zod schema is the most common silent break for old clients.

---

## Phase 3 — Security audit pass

**Always run** — even when \`pnpm-lock.yaml\` is unchanged. New CVEs get disclosed against packages already pinned in the lockfile, so a clean diff doesn't mean a clean audit.

Start with a quick \`pnpm audit\` against the current lockfile. If it's clean and (where present) \`.specs/audit.md\` is current, you're done with Phase 3 in one command. If there are new findings, run the full process below to triage them.

If the repo has a \`.specs/audit.md\`, it owns the override **reference table** (what's pinned and *why*). This skill owns the **process** for updating it. If the repo has no audit doc, just report findings — don't create the file unless the user asks.

### Audit process

1. Remove ALL overrides from \`package.json\` (security + dedup).
2. \`pnpm install --no-frozen-lockfile\`.
3. If \`apps/mobile/\` exists: \`cd apps/mobile && npx expo-doctor\` — check Expo SDK compatibility first.
4. Re-add dedup overrides if still needed, \`pnpm install\`.
5. \`pnpm audit\` — note what's still vulnerable.
6. For each vuln: \`pnpm why <pkg>\` — if upstream fixed it, no override needed.
7. Add security overrides only for transitive deps where the fix is a semver-compatible bump.
8. \`pnpm install && pnpm audit\` — verify.
9. If \`.specs/audit.md\` exists, **update it** with the new override row(s), source chain, and the *reason* (CVE, behavior, or compatibility issue). A row without a reason is worse than no row.

**Don't override** if: major version jump required, dev-only with no prod exposure, or it's a direct dep (just upgrade it).

---

## Phase 4 — Commit prod-check fixes

This phase **intentionally violates** the repo's "never commit without user approval" rule in CLAUDE.md. It is the one sanctioned exception: prod-check is explicitly invoked by the user as a pre-production gate, and the commit captures only the deterministic fixes the gate produced (lint:fix output, type-error fixes, audit override updates). Always tell the user the commit happened and what's in it.

Skip this phase entirely if:

- Phase 1 had unresolved failures (the user must triage first), OR
- \`git status\` is clean (nothing was changed), OR
- The diff includes changes you didn't make in this session — in that case, **stop and ask** rather than sweeping unrelated work into a prod-check commit.

### Commit steps

1. \`git status --short\` — confirm only files touched by Phase 1–3 are dirty.
2. \`git diff\` — sanity-check the contents one more time.
3. Stage **only** the files this session modified (name them explicitly; do **not** \`git add -A\`).
4. Commit with a HEREDOC message:
   \`\`\`
   chore(prod-check): apply pre-production gate fixes

   - <bulleted list of what was fixed: lint:fix, type errors, audit overrides, etc>
   \`\`\`
   No \`Co-Authored-By\` trailer (factiii-stack CLAUDE.md forbids it).
5. Do **not** push. Pushing is always the user's call.
6. In your final report, surface a clearly-labeled note:
   > **Auto-committed by prod-check:** \`<commit sha>\` — <one-line summary>. This skill is allowed to commit pre-prod gate fixes; review with \`git show <sha>\` and amend or revert if anything looks off.

---

## Final report format

Group findings into two buckets. Be specific — name files, line numbers, migration filenames.

\`\`\`
BLOCKING (must resolve before merging to production):
- <finding> — <file:line> — <what to do>

INFORMATIONAL (no action needed, just FYI):
- <finding> — <file:line>

AUTO-COMMIT:
- <sha or "none — nothing to commit"> — <summary>
\`\`\`

If Phase 1 had failures the user must triage, surface those at the top before any Phase 2 findings and skip Phase 4.

---

## Notes

- Installed by the \`prod-check-skill\` scanfix in \`@factiii/stack\` (factiii pipeline). Run \`npx stack fix --dev\` from any factiii-pipeline repo to install or restore it.
- This file is shared across all factiii-pipeline repos on the machine — keep it generic. Per-repo specifics (audit override tables, etc.) belong in the consumer repo.
`;

/**
 * Read the per-developer opt-in flag from stack.local.yml.
 * Defaults to false: host-machine fixes never run unless explicitly enabled.
 */
function isOptedIn(rootDir: string): boolean {
  try {
    const local = loadLocalConfig(rootDir);
    return local.claude_skills === true;
  } catch {
    return false;
  }
}

export const prodCheckSkillFixes: Fix[] = [
  {
    id: 'prod-check-skill-installed',
    stage: 'dev',
    severity: 'warning',
    description:
      'Claude Code prod-check skill is missing at ~/.claude/skills/prod-check/SKILL.md — pre-prod gates (lint/types/tests/build + branch diff vs production + secret scan + audit) cannot be invoked consistently without it (enable with `claude_skills: true` in stack.local.yml)',
    scan: async function (_config, rootDir): Promise<boolean> {
      // Opt-in gate: if the dev hasn't enabled claude_skills in stack.local.yml,
      // report no issue. This keeps the scanfix invisible to devs who don't
      // want their ~/.claude/ touched.
      if (!isOptedIn(rootDir)) return false;
      // Returns true when there IS an issue (skill missing).
      return !fs.existsSync(SKILL_FILE);
    },
    fix: async function (_config, rootDir): Promise<boolean> {
      // Belt-and-braces: even if scan ever returned a stale result, fix
      // re-checks the opt-in before touching the host filesystem.
      if (!isOptedIn(rootDir)) return true;
      // Local-only: write SKILL.md into the user's home dir.
      // Idempotent: only writes if missing, so a user who has hand-edited
      // their copy won't get clobbered. Delete the file to force a refresh.
      if (!fs.existsSync(SKILL_DIR)) {
        fs.mkdirSync(SKILL_DIR, { recursive: true });
      }
      if (!fs.existsSync(SKILL_FILE)) {
        fs.writeFileSync(SKILL_FILE, SKILL_CONTENT, 'utf8');
      }
      return true;
    },
    manualFix:
      'Set `claude_skills: true` in stack.local.yml and run `npx stack fix --dev`, or create ~/.claude/skills/prod-check/SKILL.md by hand.',
  },
];
