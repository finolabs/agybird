---
name: agybird-status
description: Show running and recent Agybird jobs for this repository. Use only when the user asks for it by name, types $agybird-status, or asks for this through Agybird, agy or Antigravity.
---

# Show running and recent Agybird jobs for this repository

The plugin root is the folder two directories above the one that holds this file. Run the command below with the shell from the user's repository. Pass each of the user's arguments as its own single-quoted word and nothing else; if an argument contains a single quote or a newline, stop and ask the user to rephrase it.

```bash
node "<plugin-root>/scripts/companion.mjs" status [job-id] [--all]
```

Show the table as printed. Do not wait for a running job.
