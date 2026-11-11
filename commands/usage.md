---
description: Show Antigravity quota per pool and the model Agybird would pick for each tier
argument-hint: '[--refresh]'
disable-model-invocation: true
---

Run this with the Bash tool, adding `--refresh` after `usage` only if the user passed it. Pass nothing else.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" usage
```

The user's arguments: $ARGUMENTS

Show the table as printed. Reset times are already in local time.
