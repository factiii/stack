# .spec — AI Operating Specs

Minimal specs for consistent AI behavior on this codebase. For full standards, see `STANDARDS.md`. For AI rules, see `CLAUDE.md`.

| File | When to load |
|------|-------------|
| `config.md` | Touching stack.yml, stackAuto.yml, stack.local.yml, or environment config |
| `flow.md` | Understanding deployment flow, fix vs deploy boundary, AWS strategy |
| `triggering.md` | Adding cross-stage scanfixes, deciding what runs on dev vs staging vs prod |
| `types.md` | Writing any TypeScript in this repo |
