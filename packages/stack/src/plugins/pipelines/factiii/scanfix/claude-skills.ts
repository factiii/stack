/**
 * Claude Code skill scanfixes for Factiii Pipeline plugin
 *
 * Installs the three "standard" Claude Code skills the team uses across every
 * factiii-pipeline repo, so any Claude Code session in any repo can rely on
 * the same `/commit`, `/push`, and `/prod-check` workflows being available
 * with the same gates.
 *
 *   ~/.claude/skills/commit/SKILL.md      — lint:fix + check-types gate, then commit
 *   ~/.claude/skills/push/SKILL.md        — scoped tests for changed code, then push
 *   ~/.claude/skills/prod-check/SKILL.md  — full pre-prod gate (lint/types/tests/build
 *                                            + branch diff vs production + secret scan
 *                                            + audit + auto-commit fixes)
 *
 * All three SKILL.md bodies are intentionally **generic across factiii-pipeline
 * repos**: they live once at ~/.claude/skills/ and are shared by every repo on
 * the machine, so they detect repo shape at runtime (apps/server, packages/*,
 * Prisma, etc.) rather than hardcoding paths from any one repo.
 *
 * Local-only (no SSH, no GITHUB_ACTIONS check). Stage: dev.
 * Severity: warning — missing skills don't break deploys, but having them
 * available is what enforces the gates the team relies on.
 *
 * OPT-IN: These are "host-machine fixes" — they write to ~/.claude/, which is
 * the developer's personal Claude Code config, not project state. Per
 * STANDARDS.md "Host-Machine Fixes", they are gated behind an explicit opt-in
 * in stack.local.yml (`claude_skills: true`). When the flag is unset or false,
 * scan returns "no issue" and fix is a no-op. This keeps devs who don't use
 * Claude Code (or who curate their own skills) from being surprised by files
 * appearing in their home directory.
 *
 * REFRESH BEHAVIOR: Unlike the previous scanfix (which only wrote when the
 * file was missing), this one **overwrites when the on-disk content drifts
 * from the canonical content baked into stack**. That way `npx stack fix --dev`
 * propagates skill updates to every dev who has opted in. If a dev wants to
 * customize their local copy and not have stack stomp it, they can add the
 * line `<!-- user-managed -->` anywhere in the file — the scanfix will detect
 * the marker and skip that file.
 *
 * Split of concerns:
 *   - This scanfix owns the skill *workflows* (SKILL.md content). Process
 *     lives here so it ships with stack and is identical on every dev machine
 *     that opts in.
 *   - The audit *override reference table* (which packages, why) is optional
 *     per-repo at .specs/audit.md so PR reviewers can see it; the prod-check
 *     skill uses it if present and skips it if not.
 *   - Phase 4 of the prod-check SKILL.md auto-commits the deterministic fixes
 *     the gate produced. This is a sanctioned exception to factiii-stack's
 *     "never commit without approval" rule because prod-check is itself an
 *     explicit user-invoked gate; the skill always reports the resulting
 *     commit SHA back to the user.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Fix } from '../../../../types/index.js';
import { loadLocalConfig } from '../../../../utils/config-helpers.js';

const SKILLS_ROOT = path.join(os.homedir(), '.claude', 'skills');
const USER_MANAGED_MARKER = '<!-- user-managed -->';

// ─────────────────────────────────────────────────────────────────────────────
// commit SKILL.md — gate: pnpm lint:fix + pnpm check-types, then commit
// ─────────────────────────────────────────────────────────────────────────────

const COMMIT_SKILL_CONTENT = `---
name: commit
description: Create a git commit in any repo, gated by quality checks. Runs \`pnpm lint:fix\` and \`pnpm check-types\` first (skipping whichever isn't defined); only proceeds to commit if both pass. TRIGGER when the user invokes /commit or asks to commit changes.
---

# commit

Create a git commit, but only after the workspace passes the same quality gates that block CI. The point: never land a commit that breaks types or has trivially auto-fixable lint noise.

This skill is installed once globally in \`~/.claude/skills/\` and is shared by every repo on the machine. Detect what's available before running anything; skip steps whose script doesn't exist rather than failing.

## Phase 0 — Detect repo shape

Read the root \`package.json\` once and record which of these scripts exist:

- \`lint:fix\`
- \`check-types\`

Both are optional. A repo that defines neither still gets a commit (just with no gates).

## Steps

1. **Inspect what's being committed** — \`git status\` and \`git diff\` (both staged and unstaged) so you understand the change before gating it. If there are no changes, stop and tell the user.

2. **Auto-fix lint** — if \`lint:fix\` exists, run \`pnpm lint:fix\` from the repo root. This cleans import order, unused imports, prettier, prefer-const. Do not chase auto-fixable categories as findings — let the fixer handle them. If \`lint:fix\` itself errors out (not just modifies files), stop and report.

3. **Type check** — if \`check-types\` exists, run \`pnpm check-types\`. Type errors are blocking. Do NOT commit if this fails. If the errors are in code the user just changed, fix them and re-run. If they look pre-existing or need user judgment, stop and report before committing — do not paper over with \`@ts-ignore\` or \`any\`.

4. **Re-inspect** — \`lint:fix\` may have modified files. Run \`git status\` / \`git diff\` again so the commit message reflects the post-fix state.

5. **Commit** — follow the standard commit protocol from the system prompt:
   - Stage specific files by name (never \`git add -A\` / \`git add .\`).
   - Draft a concise message focused on the *why*.
   - **Do NOT include a \`Co-Authored-By\` trailer** — factiii repos forbid it; absence is the safe default.
   - Use a HEREDOC for the commit message to preserve formatting.
   - Never \`--amend\`, never \`--no-verify\`.

6. **Verify** — run \`git status\` after the commit to confirm it landed and report the commit hash to the user.

## Notes

- Installed by the \`commit-skill\` scanfix in \`@factiii/stack\` (factiii pipeline). Run \`npx stack fix --dev\` from any factiii-pipeline repo to install or restore it.
- This file is shared across all factiii-pipeline repos on the machine — keep it generic. If you want to hand-edit your local copy and stop stack from refreshing it, add the line \`<!-- user-managed -->\` anywhere in the file.
- If pre-commit hooks fail, do NOT amend — fix the issue, re-stage, create a new commit.
- Do not push unless the user explicitly asks (\`/push\` is the right next step).
- If the user passes a message via args (\`/commit -m "..."\`), respect it but still run gates first.
`;

// ─────────────────────────────────────────────────────────────────────────────
// push SKILL.md — gate: scoped tests for changed code, then push
// ─────────────────────────────────────────────────────────────────────────────

const PUSH_SKILL_CONTENT = `---
name: push
description: Push the current branch in any repo, gated by tests scoped to the code that actually changed. Detects which apps/* and packages/* directories exist, maps the branch's diff onto them, and runs only those test suites. TRIGGER when the user invokes /push or asks to push the current branch.
---

# push

Push the current branch, but only after the tests that *matter for this change* are green. The point: don't run the entire monorepo's test matrix on every push, but never push code whose tests weren't run.

This skill sits between \`/commit\` (cheap local gates: lint:fix + check-types) and \`/prod-check\` (full pre-prod sweep including audit). Use it for the everyday "I'm ready to share this branch" moment.

This skill is installed once globally in \`~/.claude/skills/\` and is shared by every repo on the machine. Repo layouts vary — **detect what exists before running step-specific commands**. Never invent paths.

---

## Phase 0 — Detect repo shape

Inspect the working directory and record:

- Every directory under \`apps/\` that contains a \`package.json\`. Each is a candidate **bucket**.
- Every directory under \`packages/\` that contains a \`package.json\`. Each is a candidate **bucket**.
- For every bucket, whether its \`package.json\` defines a \`test\` script (and a \`seed:test\` script — if present, run it before \`test\`).
- Whether a top-level \`shared/\` (or \`packages/shared/\`) directory exists.
- Whether the **root** \`package.json\` defines a \`test\` script (some repos use a single root suite instead of per-bucket).

The list of buckets *is* the test scope. A repo with only \`packages/stack\` and \`packages/auth\` has two buckets; a repo with \`apps/server\`, \`apps/client\`, and \`apps/mobile\` has three. Treat them uniformly.

---

## Steps

1. **Sanity check the working tree** — \`git status\`. If there are uncommitted changes, stop and tell the user to \`/commit\` first. Pushing dirty state is never what they meant.

2. **Determine what actually changed** — figure out the diff against the upstream:
   - If the branch tracks a remote: \`git diff --name-only @{u}...HEAD\`.
   - Otherwise diff against \`origin/main\`: \`git fetch origin main\` then \`git diff --name-only origin/main...HEAD\`.
   - If the diff is empty, stop and report — there's nothing to push.

3. **Map changed paths to buckets** — for each changed file, add to the run set whichever bucket(s) match:

   | Pattern | Buckets to run |
   |---|---|
   | \`apps/<name>/**\` | the matching \`apps/<name>\` bucket |
   | \`packages/<name>/**\` | the matching \`packages/<name>\` bucket |
   | \`shared/**\` or \`packages/shared/**\` | every other bucket that imports shared (when in doubt, run them all — shared validators are exercised everywhere) |
   | \`package.json\`, \`pnpm-lock.yaml\`, \`pnpm-workspace.yaml\`, \`tsconfig*.json\` (root) | **every** bucket — a workspace/dep change can break anything |
   | \`.github/**\`, \`*.md\`, \`stack.yml\`, \`stackAuto.yml\`, \`docker-compose*.yml\` | none (no test-relevant changes) |
   | anything else that doesn't match | the closest containing bucket; if none, run all buckets (be conservative) |

   If *only* no-test-relevant files changed, skip Step 4 entirely and note "no test-relevant changes" in the report. If the run set ends up empty for any other reason, run **every** bucket — better to test too much than too little.

4. **Run the selected test commands** — for each bucket in the run set, in order (\`apps/*\` before \`packages/*\` is a fine default):

   - If the bucket defines \`seed:test\`, run \`pnpm --filter <bucket-name> seed:test\` first. Skipping it produces misleading failures in repos that have a seed step.
   - Then run \`pnpm --filter <bucket-name> test\`.
   - If a bucket has no \`test\` script, skip it and note that in the report rather than failing.
   - If a bucket fails, stop immediately and report. Do not push.

   If the repo only defines a root \`test\` script (no per-bucket scripts), run \`pnpm test\` once instead of iterating.

5. **Push** — \`git push\`. If the branch has no upstream, use \`git push -u origin <branch>\`. Never \`--force\` or \`--no-verify\` unless the user explicitly asked.

6. **Report** — one short summary: which buckets ran, which were skipped (and why), the push result, and the remote branch URL if visible from \`git push\` output.

---

## Notes

- Installed by the \`push-skill\` scanfix in \`@factiii/stack\` (factiii pipeline). Run \`npx stack fix --dev\` from any factiii-pipeline repo to install or restore it.
- This file is shared across all factiii-pipeline repos on the machine — keep it generic. If you want to hand-edit your local copy and stop stack from refreshing it, add the line \`<!-- user-managed -->\` anywhere in the file.
- This skill is about *scoping* tests, not skipping them. If you can't confidently determine the scope (weird path, generated file, unfamiliar package), run more tests rather than fewer.
- If the user wants the full matrix anyway, they can run \`pnpm test\` from the root themselves — don't second-guess that.
- Don't run lint or type checks here — those belong to \`/commit\`. Don't run audit or schema diffs — those belong to \`/prod-check\`.
- Don't create commits in this skill. If tests modify files (snapshots, etc.), stop and tell the user to review and \`/commit\` the updates.
`;

// ─────────────────────────────────────────────────────────────────────────────
// prod-check SKILL.md — full pre-prod gate (already generic across repos)
// ─────────────────────────────────────────────────────────────────────────────

const PROD_CHECK_SKILL_CONTENT = `---
name: prod-check
description: Pre-production verification for any factiii-pipeline repo. Runs a security audit, quality gates (lint, types, tests, build), diffs the current branch against origin/production for schema/migration/env/secret/API changes, and commits the resulting fixes. TRIGGER when the user asks to check a branch against production, prepare a production push, run pre-merge checks, or audit dependencies before release.
---

# prod-check

Pre-production verification workflow for **factiii-pipeline repos**. Runs in four phases: **sync & audit**, **fix locally**, **diff against production**, then **commit**. Report at the end groups findings as **BLOCKING** vs **INFORMATIONAL**.

The whole point: nothing should reach \`origin/production\` that hasn't passed local quality gates and been reviewed for schema, secret, and API-breaking changes.

This skill is installed once globally in \`~/.claude/skills/\` and is shared by every factiii-pipeline repo on your machine. Repo layouts vary — **detect what exists before running step-specific commands**. Skip steps that don't apply (e.g. no \`apps/mobile\` → no Expo doctor; no Prisma schema → no migration diff). Never invent paths.

---

## Phase 0 — Detect repo shape

Before running anything, inspect the working directory and record which of these exist. Every later phase branches on this list:

- \`apps/server\` (Node server app)
- \`apps/client\` (web client)
- \`apps/mobile\` (Expo mobile app)
- Any \`packages/<name>\` directories with their own \`package.json\`
- \`apps/server/prisma/schema.prisma\` and \`apps/server/prisma/migrations/\`
- \`apps/server/src/routes/\` (tRPC route tree)
- \`shared/\` or \`packages/shared/\` validator dir (look for \`validators/\` underneath)
- \`.specs/audit.md\` (audit override reference table — optional)
- Root scripts: which of \`lint:fix\`, \`lint\`, \`check-types\`, \`test\`, \`build\` exist in root \`package.json\`

If a repo has only a server, run only server steps. If it has no Prisma, skip schema/migration diffing. If it's a packages-only repo (no \`apps/\`), iterate \`packages/*\` instead. **Do not fail a phase because an optional path is missing — note it as "n/a for this repo" and move on.**

---

## Phase 1 — Sync & security audit

Audit runs **before** tests and build so that quality gates execute against the final dependency tree. The quick \`pnpm audit\` is cheap; pay for it before paying for tests.

1. **Sync** — \`git fetch origin production\` and confirm the working tree is clean (\`git status\`). Stash or commit anything dirty before continuing; uncommitted state contaminates the diff in Phase 3.
2. **Quick audit gate** — \`pnpm audit\` against the current lockfile. **Always run** — even when \`pnpm-lock.yaml\` is unchanged. New CVEs get disclosed against packages already pinned in the lockfile, so a clean diff doesn't mean a clean audit. If clean and (where present) \`.specs/audit.md\` is current, Phase 1 is done — move to Phase 2.
3. **Full triage** — only if the quick audit surfaced findings. Run the process below **now** (not after tests/build), so Phase 2 executes against the corrected deps and you don't have to re-test.

If the repo has a \`.specs/audit.md\`, it owns the override **reference table** (what's pinned and *why*). This skill owns the **process** for updating it. If the repo has no audit doc, just report findings — don't create the file unless the user asks.

### Audit triage process

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

## Phase 2 — Local quality gates (fix before continuing)

Run in this order against the scripts that exist. Each step must be green before moving on. If a step fails, fix it (or report blockers and stop) — do not skip.

1. **Auto-fix lint noise** — \`pnpm lint:fix\` if the script exists. This cleans import order, unused imports, prettier, prefer-const so the type/test output isn't drowned in cosmetic churn. Always run the fixer first; ignore auto-fixable categories as *findings*.
2. **Type check** — \`pnpm check-types\`. Fix every error. No \`@ts-ignore\`, no \`any\` (use \`unknown\`). Type errors are blocking.
3. **Lint (real rules)** — \`pnpm lint\`. Focus on what matters: promise handling, hooks rules, real type issues. Auto-fixable categories are noise — don't chase them.
4. **Tests** — for each bucket detected in Phase 0 that has a \`test\` script: if it also has \`seed:test\`, run that first, then \`test\`. Skipping the seed step produces misleading failures in repos that have one.
5. **Build everything that exists** — \`pnpm build\` from the root. All present apps/packages must build. A green local dev does not imply a green build.

If any step surfaces failures you can fix safely, fix them. If failures need user judgment (e.g. a failing test reflects intended behavior change), stop and report before continuing.

---

## Phase 3 — Diff against production

Only run after Phase 2 is fully green. Use \`origin/production\` as the base (refresh with \`git fetch origin production\` if Phases 1–2 took a while). For every path-based check below, only run it if the path exists in this repo.

1. **Overall diffstat** — \`git diff --stat origin/production...HEAD\` for orientation.
2. **Schema & migrations** — only if \`apps/server/prisma/schema.prisma\` exists. \`git diff origin/production...HEAD -- apps/server/prisma/schema.prisma 'apps/server/prisma/migrations/**'\`.
   - Comment-only schema changes = informational.
   - Field/model/index changes = blocking unless paired with a migration.
   - **New migration files = blocking action**: they need to be applied to prod DB during deploy. Call this out explicitly with the migration name(s).
3. **Secrets scan** — always. Search the diff for committed credentials. Patterns to grep: \`AKIA[0-9A-Z]{16}\` (AWS access key), \`-----BEGIN .* PRIVATE KEY-----\`, \`sk_live_\`, \`sk_test_\`, \`xox[baprs]-\`, \`ghp_\`, \`Bearer [A-Za-z0-9_\\-]{20,}\`, raw \`password\\s*[:=]\`, \`client_secret\`. Run against \`git diff origin/production...HEAD\`. Anything matching is **BLOCKING** — instruct the user to rotate the credential in its provider before merging, since git history is forever.
4. **Env / infra surface** — diff whichever of these exist and flag any change:
   - \`stack.yml\`, \`stackAuto.yml\`, \`docker-compose*.yml\`
   - \`.github/workflows/**\`
   - \`start.sh\`, root \`package.json\`, any \`apps/*/package.json\` or \`packages/*/package.json\` (deps)
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

## Phase 4 — Commit prod-check fixes

This phase **intentionally violates** the repo's "never commit without user approval" rule in CLAUDE.md. It is the one sanctioned exception: prod-check is explicitly invoked by the user as a pre-production gate, and the commit captures only the deterministic fixes the gate produced (lint:fix output, type-error fixes, audit override updates). Always tell the user the commit happened and what's in it.

Skip this phase entirely if:

- Phase 1 or Phase 2 had unresolved failures (the user must triage first), OR
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
5. Do **not** push. Pushing is always the user's call (\`/push\` is the right next step).
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

If Phase 1 or Phase 2 had failures the user must triage, surface those at the top before any Phase 3 findings and skip Phase 4.

---

## Notes

- Installed by the \`prod-check-skill\` scanfix in \`@factiii/stack\` (factiii pipeline). Run \`npx stack fix --dev\` from any factiii-pipeline repo to install or restore it.
- This file is shared across all factiii-pipeline repos on the machine — keep it generic. If you want to hand-edit your local copy and stop stack from refreshing it, add the line \`<!-- user-managed -->\` anywhere in the file.
- Per-repo specifics (audit override tables, etc.) belong in the consumer repo at \`.specs/audit.md\`.
`;

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Decide whether the on-disk SKILL.md needs (re)writing.
 *
 * Returns true if:
 *   - the file is missing, OR
 *   - the file content differs from the canonical content AND the file does
 *     not contain the user-managed marker (so devs who hand-edit can opt out
 *     by adding `<!-- user-managed -->` anywhere in the file).
 */
function needsInstall(file: string, canonical: string): boolean {
  if (!fs.existsSync(file)) return true;
  const current = fs.readFileSync(file, 'utf8');
  if (current.includes(USER_MANAGED_MARKER)) return false;
  return current !== canonical;
}

/**
 * Idempotently install a SKILL.md to ~/.claude/skills/<name>/SKILL.md,
 * honoring the user-managed opt-out marker.
 */
function installSkill(name: string, content: string): void {
  const dir = path.join(SKILLS_ROOT, name);
  const file = path.join(dir, 'SKILL.md');
  if (!needsInstall(file, content)) return;
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

/**
 * Build a Fix definition for one of the standard skills. The shape is the
 * same for all three — only the id, description, name, and content vary.
 */
function makeSkillFix(args: {
  id: string;
  skillName: string;
  description: string;
  content: string;
}): Fix {
  const file = path.join(SKILLS_ROOT, args.skillName, 'SKILL.md');
  return {
    id: args.id,
    stage: 'dev',
    severity: 'warning',
    description: args.description,
    scan: async function (_config, rootDir): Promise<boolean> {
      // Opt-in gate: invisible to devs who haven't enabled claude_skills.
      if (!isOptedIn(rootDir)) return false;
      // Returns true when there IS an issue (skill missing or stale).
      return needsInstall(file, args.content);
    },
    fix: async function (_config, rootDir): Promise<boolean> {
      // Belt-and-braces: re-check the opt-in before touching ~/.claude.
      if (!isOptedIn(rootDir)) return true;
      installSkill(args.skillName, args.content);
      return true;
    },
    manualFix: `Set \`claude_skills: true\` in stack.local.yml and run \`npx stack fix --dev\`, or create ${file} by hand.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Exported fixes
// ─────────────────────────────────────────────────────────────────────────────

export const claudeSkillFixes: Fix[] = [
  makeSkillFix({
    id: 'commit-skill-installed',
    skillName: 'commit',
    description:
      'Claude Code commit skill is missing or stale at ~/.claude/skills/commit/SKILL.md — the lint:fix + check-types pre-commit gate cannot be invoked consistently without it (enable with `claude_skills: true` in stack.local.yml; add `<!-- user-managed -->` to the file to opt out of refresh)',
    content: COMMIT_SKILL_CONTENT,
  }),
  makeSkillFix({
    id: 'push-skill-installed',
    skillName: 'push',
    description:
      'Claude Code push skill is missing or stale at ~/.claude/skills/push/SKILL.md — scoped pre-push tests cannot be invoked consistently without it (enable with `claude_skills: true` in stack.local.yml; add `<!-- user-managed -->` to the file to opt out of refresh)',
    content: PUSH_SKILL_CONTENT,
  }),
  makeSkillFix({
    id: 'prod-check-skill-installed',
    skillName: 'prod-check',
    description:
      'Claude Code prod-check skill is missing or stale at ~/.claude/skills/prod-check/SKILL.md — pre-prod gates (lint/types/tests/build + branch diff vs production + secret scan + audit) cannot be invoked consistently without it (enable with `claude_skills: true` in stack.local.yml; add `<!-- user-managed -->` to the file to opt out of refresh)',
    content: PROD_CHECK_SKILL_CONTENT,
  }),
];
