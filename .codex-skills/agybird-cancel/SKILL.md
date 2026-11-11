---
name: agybird-cancel
description: Cancel a running Agybird background job. Use only when the user asks for it by name, types $agybird-cancel, or asks for this through Agybird, agy or Antigravity.
---

# Cancel a running Agybird background job

The plugin root is the folder two directories above the one that holds this file. Run the command below with the shell from the user's repository. Pass each of the user's arguments as its own single-quoted word and nothing else; if an argument contains a single quote or a newline, stop and ask the user to rephrase it.

```bash
command node "<plugin-root>/scripts/companion.mjs" cancel [job-id]
```

Report the line it prints.
