---
"@factiii/stack": patch
---

add prod-check Claude Code skill scanfix, gated on `claude_skills` opt-in in `stack.local.yml`. Off by default — `~/.claude/` is the developer's personal config and stack will not write to it unless explicitly enabled. STANDARDS.md documents the new "Host-Machine Fixes" rule that any future scanfix touching the dev's home directory must follow.
