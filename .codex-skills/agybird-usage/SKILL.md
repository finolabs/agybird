---
name: agybird-usage
description: Show Antigravity quota per pool and the model Agybird would pick for each tier. Use only when the user asks for it by name, types $agybird-usage, or asks for this through Agybird, agy or Antigravity.
---

# Show Antigravity quota per pool and the model Agybird would pick for each tier

The plugin root is the folder two directories above the one that holds this file. Run the command below with the shell from the user's repository. Pass each of the user's arguments as its own single-quoted word and nothing else; if an argument contains a single quote or a newline, stop and ask the user to rephrase it.

```bash
command node "<plugin-root>/scripts/companion.mjs" usage [--refresh]
```

Show the table as printed; reset times are local.
