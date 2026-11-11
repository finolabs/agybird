---
description: Generate an image, or edit reference images, with Antigravity's image generation
argument-hint: '[--reference <absolute path>]... <what the image should show>'
disable-model-invocation: true
---

Run this with the Bash tool. Put each `--reference <path>` the user gave after `image` as its own single-quoted words, refusing a path that contains a single quote, and pass the description on standard input through a quoted here-document whose delimiter does not occur in it. Give the Bash call a 10-minute timeout.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" image <references> <<'AGYBIRD_IMAGE_7F3A'
<the user's description>
AGYBIRD_IMAGE_7F3A
```

The user's request: $ARGUMENTS

Report the result as printed. Open each listed image and check it against the request before calling it done; if it does not match, say so. To put an image at a particular path or format, copy or convert the listed file yourself after checking it.
