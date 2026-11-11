---
name: agybird-image
description: Generate an image, or edit reference images, with Antigravity image generation through Agybird. Use only when the user asks for it by name, types $agybird-image, or asks for this through Agybird, agy or Antigravity.
---

# Generate an image, or edit reference images, with Antigravity image generation through Agybird

The plugin root is the folder two directories above the one that holds this file. Run the command below with the shell from the user's repository. Pass each of the user's arguments as its own single-quoted word and nothing else; if an argument contains a single quote or a newline, stop and ask the user to rephrase it. Pass the user's description of the image on standard input through a quoted here-document whose delimiter does not occur in it, and allow up to 10 minutes.

```bash
node "<plugin-root>/scripts/companion.mjs" image [--reference <absolute path>]... <<'AGYBIRD_INPUT_7F3A'
<the user's description of the image>
AGYBIRD_INPUT_7F3A
```

Open each listed image and check it against the request before calling it done. To place an image at a particular path or format, copy or convert the listed file yourself after checking it.
