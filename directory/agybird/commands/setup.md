---
description: Check that the Antigravity CLI is installed and signed in, and switch the Agybird review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
disable-model-invocation: true
---

Run this with the Bash tool, adding the user's flag after `setup` only if it is exactly `--enable-review-gate` or `--disable-review-gate`. Pass nothing else.

```bash
command node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup
```

The user's arguments: $ARGUMENTS

Report what it prints. If `agy` is missing or not signed in, point the user to https://antigravity.google/docs/cli/install and tell them to run `agy` once to sign in; do not install anything yourself. When the gate was just turned on, say that from now on each time Claude finishes a turn with uncommitted changes in this repository, Antigravity reviews them read-only, which uses quota.
