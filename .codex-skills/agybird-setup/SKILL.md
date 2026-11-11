---
name: agybird-setup
description: Check that the Antigravity CLI (agy) is installed and signed in, and switch the Agybird review gate. Use only when the user asks for it by name, types $agybird-setup, or asks for this through Agybird, agy or Antigravity.
---

# Check that the Antigravity CLI (agy) is installed and signed in, and switch the Agybird review gate

The plugin root is the folder two directories above the one that holds this file. Run the command below with the shell from the user's repository. Pass each of the user's arguments as its own single-quoted word and nothing else; if an argument contains a single quote or a newline, stop and ask the user to rephrase it.

```bash
node "<plugin-root>/scripts/companion.mjs" setup [--enable-review-gate|--disable-review-gate]
```

Report what it prints. If agy is missing or not signed in, point the user to https://antigravity.google/docs/cli/install and to running `agy` once to sign in; install nothing yourself. The review gate runs as a Codex Stop hook only after the user has reviewed and trusted this plugin's hooks; when the gate was just turned on, say that each finished turn with uncommitted changes then gets a read-only Antigravity review, which uses quota.
