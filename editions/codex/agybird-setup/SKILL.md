---
name: agybird-setup
description: Check that the Antigravity CLI (agy) is installed and signed in, and show its quota. Use only when the user asks for it by name, types $agybird-setup, or asks for this through Agybird, agy or Antigravity.
---

# Check that the Antigravity CLI (agy) is installed and signed in

The plugin root is the folder two directories above the one that holds this file. Run the command below with the shell from the user's repository and pass nothing else.

```bash
command node "<plugin-root>/scripts/companion.mjs" setup
```

Report what it prints. If agy is missing or not signed in, point the user to https://antigravity.google/docs/cli/install and to running `agy` once to sign in; install nothing yourself.
