---
description: Show running and recent Agybird jobs for this repository
argument-hint: '[job-id] [--all]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" status "$ARGUMENTS"`

Show the table above as it is. When a job id was given and it is still running, say so in one line and do not wait for it.
