# Caddy-Based Staging Router + Git-Free Prod Deploy

## Status (2026-04)
**Foundation landed, migration not started.** These pieces are in place:
- `src/generators/generate-prod-compose.ts` + `generate-prod-nginx.ts` — reusable single-tenant generators.
- `src/utils/dag-runner.ts` + `src/types/plugin.ts` Fix `requires` / `serializeOn` fields — dependency-ordered scanfix execution with skip propagation and cycle detection. Tested in `test/dag-runner.test.ts`.
- `src/utils/ssh-tunnel.ts` — OpenSSH `ControlMaster` multiplexer so staging/prod scanfixes share one SSH connection instead of paying the handshake N times.
- `src/plugins/pipelines/factiii/scanfix/stack-version-pin.ts` — dev-only CLI version guard.

The work below is the actual cutover: new scanfixes that declare `requires`, a CLI entry point that uses `runFixDAG`, and `canReach('prod')` flipped so dev drives everything.

## Goal

Two related shifts, both leaning on the new prod generators:

1. **Dev-direct prod deploy** — the dev machine generates compose + nginx + `.env.prod`, ships them to the prod server over SSH (no git clone, no Node on the server), and triggers `docker compose pull && up -d`. Prod needs only `ssh` + `docker` + the compose plugin.
2. **Caddy-routed staging** — replace the multi-tenant mac-mini staging model with one VM per stack. Caddy on the mac-mini host terminates TLS and reverse-proxies by `Host` header to each VM. Each staging VM becomes single-tenant and uses the same dev-direct pattern prod will use.

## Why

- AWS prod already generates compose/nginx on the dev machine for the fresh-server path — the generators were extracted so both AWS and non-AWS prod can share the same shape.
- Eliminating git + Node on prod shrinks the attack surface, simplifies the "what needs to be installed" list to docker only, and makes the deploy idempotent in a way that doesn't depend on remote `npx stack` versions.
- Caddy auto-provisions Let's Encrypt per hostname; no per-VM certbot cronjobs. Adding a new stack becomes "boot a VM, register its private IP in the Caddyfile, rsync files in, done."

## Architecture sketch

```
  Internet
     │
     ▼  port 80/443
  Mac mini (Caddy)                       Caddyfile:
     │                                     factiii-staging.example.com { reverse_proxy 10.0.0.10:80 }
     │                                     greasemoto-staging.example.com { reverse_proxy 10.0.0.11:80 }
     ├─── VM: factiii-staging   (single-tenant; same dev-direct pattern as prod)
     └─── VM: greasemoto-staging
```

Each VM runs `docker compose up` against a compose file generated from its own `stack.yml`. It never hears about sibling stacks.

## Work to do (respecting the scanfix architecture — no new utils, everything is a scanfix or pipeline routing)

### Prod scanfixes (factiii pipeline)

Each maps onto a discrete "desired state on the prod server" assertion. All live under `packages/stack/src/plugins/pipelines/factiii/scanfix/`. The DAG runner orders them by `requires`, so there's no implicit array-ordering magic — every dependency is declared on the Fix itself.

- [ ] `ssh-tunnel-prod` (open the ControlMaster tunnel via `utils/ssh-tunnel.ts::openTunnel`)
      requires: `['stack-version-pin-mismatch-ok', 'vault-unlocked', 'prod-ssh-key-to-disk']`
      serializeOn: `['prod-interactive']`  (PEM prompt fallback)
- [ ] `prod-docker-installed` — scan: `tunnelExec('docker compose version')`; fix: `tunnelExec(<install-snippet>)`.
      requires: `['ssh-tunnel-prod']`  serializeOn: `['ssh-prod']`
- [ ] `prod-env-uploaded` — scan SSH-reads `~/.factiii/<repo>/.env.prod`, compares hash against what the vault+env merger produces; fix uploads.
      requires: `['ssh-tunnel-prod', 'vault-unlocked']`  serializeOn: `['ssh-prod']`
- [ ] `prod-compose-uploaded` — scan generates expected content via `generateProdCompose`, SSH-reads the server copy, compares; fix uploads.
      requires: `['ssh-tunnel-prod']`  serializeOn: `['ssh-prod']`
- [ ] `prod-nginx-uploaded` — same pattern with `generateProdNginx`.
      requires: `['ssh-tunnel-prod']`  serializeOn: `['ssh-prod']`

All use `sshExec`-through-tunnel via `tunnelExec(handle, cmd)` (no per-call handshake). Until channel multiplexing lands, `serializeOn: ['ssh-prod']` keeps them one-at-a-time on the single tunnel — easy, correct, slow. Later we'll drop the serializeOn so siblings without `requires` edges parallelize.

### Pipeline routing change

- [ ] `FactiiiPipeline.canReach('prod')` returns `via: 'local'` (not `'ssh'`) when dev has the SSH key. "local" here means "scanfixes run on the dev machine; they SSH out via the tunnel when they need server state." The existing `via: 'ssh'` path (bootstrap git + Node + `npx stack fix --prod` on the server) gets retired for prod.
- [ ] `scan.ts` and `fix.ts` gain a DAG path: when the pipeline reports `via: 'local'` for a staging/prod stage, call `runFixDAG(fixesForStage, ...)` instead of the multi-pass runner. Unified error collection + one summary at the end.
- [ ] Staging keeps its current `via: 'ssh'` path until the Caddy follow-up below.

### Deploy step (prod)

After all prod scanfixes pass, `deployStage('prod')` does the thin action:
- [ ] `docker compose pull <service>`
- [ ] `docker compose up -d`
- [ ] Health check

All over raw SSH. `deployStage` already owns this for AWS; extract the common "upload artifacts + pull + up" sequence so it also works for non-AWS prod.

### Server-mode prod scanfixes

- [ ] Several `server-mode` prod scanfixes (ubuntu sleep, ssh, ufw; tart; windows equivalents) currently assume they run *on* the server via `FACTIII_ON_SERVER=true`. Once prod routing flips to `via: 'local'`, those scanfixes need to either SSH-probe from dev or explicitly skip when off-server. Audit each before the flip.

### Caddy staging migration

- [ ] Pick a VM runtime for the mac mini. Candidates: **Tart** (already used by `openclaw` — preferred), Lima, OrbStack.
- [ ] New `staging-host-*` scanfixes under the factiii or a new addon plugin:
  - `staging-host-caddyfile-up-to-date` — generator emits a Caddyfile from all `staging` envs in stack.yml; scan compares against the file on disk; fix rewrites and `caddy reload`.
  - `staging-host-vm-present` — scan checks the VM is booted + reachable; fix boots it.
- [ ] Each staging VM reuses the prod scanfixes above (since single-tenant staging ≡ prod shape).
- [ ] Decide shared vs per-VM postgres. Shared = cheaper, couples restarts. Per-VM = cleaner, 2× RAM.
- [ ] Teardown UX: `stack staging-host remove <name>` tears down the VM and removes the Caddyfile block atomically.

### Image source for non-AWS prod (separate decision)

- [ ] Add a `registry:` field in `stack.yml` (e.g. `ghcr.io/org/repo`) so non-AWS prod can pull the app image. AWS ignores this field and uses ECR.
- [ ] Optional `--transfer-image` fallback (`docker save | ssh docker load`) for air-gapped setups.

## Out of scope for this follow-up

- Blue/green or rolling deploys on prod.
- Per-PR ephemeral staging environments (separate problem).
- Cloudflare / multi-host-per-stage routing (tracked elsewhere, per `docs/deployment-environments.md`).

## Related files already in place

- `packages/stack/src/generators/generate-prod-compose.ts` — generator
- `packages/stack/src/generators/generate-prod-nginx.ts` — generator
- `packages/stack/src/plugins/pipelines/aws/prod.ts` — current git-free reference path for AWS fresh server
- `packages/stack/src/plugins/pipelines/factiii/scanfix/stack-version-pin.ts` — dev scanfix that gates dev-direct deploys on CLI version consistency
- `packages/stack/src/plugins/pipelines/factiii/scanfix/ssh-verify.ts` — precedent for a scanfix that SSHes out from dev
