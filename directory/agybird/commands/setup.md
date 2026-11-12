---
description: Check that the Antigravity CLI is installed and signed in, and show its quota
disable-model-invocation: true
---

Run this with the Bash tool and pass nothing else.

```bash
command node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup
```

Report what it prints. If `agy` is missing or not signed in, point the user to https://antigravity.google/docs/cli/install and tell them to run `agy` once to sign in; do not install anything yourself.
