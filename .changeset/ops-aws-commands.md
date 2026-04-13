---
"@factiii/stack": minor
---

Add AWS CLI passthrough, api-query, and db-query ops commands

- `npx stack aws --<stage> "s3 ls"` — run AWS CLI commands with stage-appropriate credentials
- `npx stack ops api-query --<stage> --url /api/health` — query server API routes
- `npx stack ops db-query --<stage> --dangerous --sql "SELECT ..."` — read-only SQL via SSH
- Extract reusable SSH helpers (resolveSSHTarget, sshExecCommand) in factiii pipeline
