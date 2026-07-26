# Deployment Flow

## 4-Step 0-to-Deployed

```
1. npx stack                    # Bootstrap: creates stack.yml, stackAuto.yml, stack.local.yml
2. npx stack fix --staging      # Multi-pass fix chain: vault → SSH keys → .env → secrets
3. npx stack deploy --staging   # Scan + deploy via SSH
4. npx stack fix --prod         # Repeat for prod (then deploy --prod)
```

## Fix vs Deploy Boundary

| Responsibility | fix | deploy |
|---------------|-----|--------|
| Config files (stack.yml, .env, vault) | Yes | No |
| SSH keys, secrets | Yes | No |
| AWS provisioning (EC2, RDS, VPC) | Yes | No |
| GitHub workflow generation | Yes | No |
| nginx.conf, docker-compose.yml | No | Yes |
| SSL certificates (certbot) | No | Yes |
| Container build + restart | No | Yes |

Rule: `fix` handles config/secrets/infrastructure. `deploy` handles deployment artifacts.

## Workflow Versioning

Generated GitHub workflow files (`stack-ci.yml`) are versioned independently from the `@factiii/stack` package via `WORKFLOW_VERSION` in `src/plugins/pipelines/factiii/utils/workflows.ts`. The outdated-workflows scanner compares this constant against the version comment in existing workflow files. Only bump `WORKFLOW_VERSION` when the workflow templates change — not on every package release.

## Multi-Pass Fix

`fix.ts` runs up to 3 iterations per stage. Each pass:
1. Scans for issues
2. Runs auto-fixes for issues found
3. If any fix succeeded, re-scans to find newly-unblocked fixes
4. Stops when no new issues or no progress

This handles dependency chains in a single `npx stack fix` run:
```
vault password → vault file → store SSH key → extract SSH key → .env files
```

## AWS Strategy: 2 IAM Users

| Account | IAM User | Environments | S3 Bucket |
|---------|----------|-------------|-----------|
| Dev | `factiii-{project}-dev` | dev + staging | `factiii-{project}-dev` |
| Prod | `factiii-{project}-prod` | prod only | `factiii-{project}` |

All AWS resources tagged with `factiii:project = {project-name}`.

## Dev Reset

`npx stack dev-reset` deletes local config/secrets files (vault, SSH keys, .env, stack.yml) so you can re-test the 0-to-deployed flow from scratch. Does NOT touch AWS or server resources.
