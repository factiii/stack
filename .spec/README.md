# .spec — AI Operating Specs

Minimal specs for consistent AI behavior on this codebase. Load relevant files before operating.

| File | When to load |
|------|-------------|
| `rules.md` | Always |
| `architecture.md` | Modifying plugins, routing, stages, or deploy logic |
| `fix-format.md` | Creating or modifying scanfixes |
| `types.md` | Writing any TypeScript in this repo |
| `patterns.md` | Writing or generating files, YAML, config handling |
| `config.md` | Touching stack.yml, stackAuto.yml, stack.local.yml, or environment config |
| `flow.md` | Understanding deployment flow, fix vs deploy boundary, AWS strategy |
