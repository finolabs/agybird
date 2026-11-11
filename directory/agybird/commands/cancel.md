---
description: Cancel a running Agybird background job
argument-hint: '[job-id]'
disable-model-invocation: true
---

Run this with the Bash tool, adding each of the user's arguments after `cancel` as its own single-quoted word. Pass nothing else, and run nothing else. If an argument contains a single quote or a newline, stop and tell the user it is not a valid job id or flag.

```bash
command node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" cancel
```

The user's arguments: $ARGUMENTS

Report the line it prints as it is.
