---
description: Check that the Antigravity CLI is installed and signed in, switch the Agybird review gate, and choose the transport
argument-hint: '[--enable-review-gate|--disable-review-gate] [--transport cli|desktop [--here]]'
disable-model-invocation: true
---

Run this with the Bash tool, adding the user's flags after `setup` only if each is exactly `--enable-review-gate`, `--disable-review-gate`, `--transport cli`, `--transport desktop` or `--here` (only together with `--transport`). Pass nothing else.

```bash
command node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup
```

The user's arguments: $ARGUMENTS

Report what it prints. If `agy` is missing or not signed in, point the user to https://antigravity.google/docs/cli/install and tell them to run `agy` once to sign in; do not install anything yourself. When the gate was just turned on, say that from now on each time Claude finishes a turn with uncommitted changes in this repository, Antigravity reviews them read-only, which uses quota.

When the output shows `Transport: cli (default)`, no transport was ever chosen: ask the user once with your question tool whether Agybird should reach Antigravity through "CLI (recommended, default)" or "Desktop app via Accessibility (macOS only)", then run the command again with `--transport cli` or `--transport desktop`. Ask nothing when the output shows any other source.
