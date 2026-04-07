/**
 * prod-check skill scanfix for Factiii Pipeline plugin
 *
 * Ensures the per-user Claude Code skill at ~/.claude/skills/prod-check/SKILL.md
 * exists on the developer's machine. The skill encodes the pre-production
 * verification workflow (lint → check-types → tests → build → diff vs production
 * → secret scan → audit) so any Claude Code session can run it consistently.
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
 *   - The audit *override reference table* (which packages, why) lives in
 *     the consumer repo at .specs/audit.md so PR reviewers can see it.
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
description: Pre-production verification for the factiii monorepo. Runs quality gates (lint, types, tests, build), diffs the current branch against origin/production for schema/migration/env/secret/API changes, and runs a security audit pass. TRIGGER when the user asks to check a branch against production, prepare a production push, run pre-merge checks, or audit dependencies before release.
---

# prod-check

Pre-production verification workflow for \`jon/factiii\`. Runs in two phases: **fix everything locally first**, then **diff against production** to surface anything risky. Report at the end groups findings as **BLOCKING** vs **INFORMATIONAL**.

The whole point: nothing should reach \`origin/production\` that hasn't passed local quality gates and been reviewed for schema, secret, and API-breaking changes.

---

## Phase 1 — Local quality gates (fix before continuing)

Run in this order. Each step must be green before moving on. If a step fails, fix it (or report blockers and stop) — do not skip.

1. **Sync** — \`git fetch origin production\` and confirm the working tree is clean (\`git status\`). Stash or commit anything dirty before continuing; uncommitted state contaminates the diff in Phase 2.
2. **Auto-fix lint noise** — \`pnpm lint:fix\`. This cleans import order, unused imports, prettier, prefer-const so the type/test output isn't drowned in cosmetic churn. Per CLAUDE.md, ignore auto-fixable lint as a *finding*, but always run the fixer first.
3. **Type check** — \`pnpm check-types\`. Fix every error. No \`@ts-ignore\`, no \`any\` (use \`unknown\`). Type errors are blocking.
4. **Lint (real rules)** — \`pnpm lint\`. Focus on what matters per CLAUDE.md: promise handling, hooks rules, real type issues. Auto-fixable categories are noise — don't chase them.
5. **Server tests** — from \`apps/server/\`: \`pnpm seed:test\` first, then \`pnpm test\`. The seed step is required (see memory \`feedback_testing.md\`); skipping it produces misleading failures.
6. **Build all three apps** — \`pnpm build\`. Server, client, and mobile must all build. A green local dev does not imply a green build.

If any step in Phase 1 surfaces failures you can fix safely, fix them. If failures need user judgment (e.g. a failing test reflects intended behavior change), stop and report before continuing to Phase 2.

---

## Phase 2 — Diff against production

Only run after Phase 1 is fully green. Use \`origin/production\` as the base (refresh with \`git fetch origin production\` if Phase 1 took a while).

1. **Overall diffstat** — \`git diff --stat origin/production...HEAD\` for orientation.
2. **Schema & migrations** — \`git diff origin/production...HEAD -- apps/server/prisma/schema.prisma 'apps/server/prisma/migrations/**'\`.
   - Comment-only schema changes = informational.
   - Field/model/index changes = blocking unless paired with a migration.
   - **New migration files = blocking action**: they need to be applied to prod DB during deploy. Call this out explicitly with the migration name(s).
3. **Secrets scan** — search the diff for committed credentials. Patterns to grep: \`AKIA[0-9A-Z]{16}\` (AWS access key), \`-----BEGIN .* PRIVATE KEY-----\`, \`sk_live_\`, \`sk_test_\`, \`xox[baprs]-\`, \`ghp_\`, \`Bearer [A-Za-z0-9_\\-]{20,}\`, raw \`password\\s*[:=]\`, \`client_secret\`. Run against \`git diff origin/production...HEAD\`. Anything matching is **BLOCKING** — instruct the user to rotate the credential in its provider before merging, since git history is forever.
4. **Env / infra surface** — diff these paths and flag any change:
   - \`stack.yml\`, \`docker-compose*.yml\`
   - \`.github/workflows/**\`
   - \`start.sh\`, \`apps/server/package.json\` (deps), root \`package.json\`
   - \`pnpm-workspace.yaml\` catalog
   Changes here often need a corresponding action on the prod host (env var added, image rebuilt, workflow secret set).
5. **Breaking API changes for mobile** — old mobile builds in the wild cannot be force-updated. Diff \`apps/server/src/routes/**\` and look for:
   - Removed tRPC procedures
   - Renamed/removed input or output fields
   - Tightened Zod validators (new required fields, narrower enums)
   - Changed HTTP status codes or error shapes
   These are blocking unless the change is additive or behind a version gate.
6. **Shared validators** — diff \`shared/all/validators/**\`. Tightening a Zod schema is the most common silent break for old clients.

---

## Phase 3 — Security audit pass

**Always run** — even when \`pnpm-lock.yaml\` is unchanged. New CVEs get disclosed against packages already pinned in the lockfile, so a clean diff doesn't mean a clean audit. The whole point of this phase is to catch vulns introduced *upstream* that landed since the last prod push.

Start with a quick \`pnpm audit\` against the current lockfile. If it's clean and \`.specs/audit.md\` is current, you're done with Phase 3 in one command. If there are new findings, run the full process below to triage them.

The override **reference table** (what's pinned and *why*) lives in \`.specs/audit.md\` so it's reviewable in PRs alongside code. This skill owns the **process** for updating it.

### Audit process

1. Remove ALL overrides from \`package.json\` (security + Expo dedup).
2. \`pnpm install --no-frozen-lockfile\`.
3. \`cd apps/mobile && npx expo-doctor\` — check Expo SDK compatibility first.
4. Re-add Expo dedup overrides if still needed, \`pnpm install\`.
5. \`pnpm audit\` — note what's still vulnerable.
6. For each vuln: \`pnpm why <pkg>\` — if upstream fixed it, no override needed.
7. Add security overrides only for transitive deps where the fix is a semver-compatible bump.
8. \`pnpm install && pnpm audit\` — verify.
9. **Update \`.specs/audit.md\`** with the new override row(s), source chain, and the *reason* (CVE, behavior, or compatibility issue). A row without a reason is worse than no row.

**Don't override** if: major version jump required, dev-only with no prod exposure, or it's a direct dep (just upgrade it).

---

## Final report format

Group findings into two buckets. Be specific — name files, line numbers, migration filenames.

\`\`\`
BLOCKING (must resolve before merging to production):
- <finding> — <file:line> — <what to do>

INFORMATIONAL (no action needed, just FYI):
- <finding> — <file:line>
\`\`\`

If Phase 1 had failures the user must triage, surface those at the top before any Phase 2 findings.

---

## Notes

- This skill is installed by the \`prod-check-skill\` scanfix in \`@factiii/stack\` (factiii pipeline). Run \`npx stack fix --dev\` from the factiii repo to install or restore it.
- Workflow lives here in \`~/.claude/skills/\`; the audit override reference table lives in the factiii repo at \`.specs/audit.md\` so reasons are reviewable in PRs.
- Memory pointers: \`feedback_testing.md\` (server test seed requirement), \`reference_staging_access.md\` (staging server layout) may be useful context for related work but are not part of this skill's flow.
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
