---
description: Show running and recent Agybird jobs for this repository
argument-hint: '[job-id] [--all]'
disable-model-invocation: true
---

Run this with the Bash tool, adding each of the user's arguments after `status` as its own single-quoted word. Pass nothing else, and run nothing else. If an argument contains a single quote or a newline, stop and tell the user it is not a valid job id or flag.

```bash
command node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" status
```

The user's arguments: $ARGUMENTS

Show the table as it is. When the job is still running, say so in one line and do not wait for it.
