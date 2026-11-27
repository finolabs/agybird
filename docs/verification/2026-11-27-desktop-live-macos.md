# Live Desktop Transport Verification — macOS — 2026-11-27

> **Snapshot, not current behaviour.** This records what was observed on 27 November
> 2026 while the desktop transport was built (issue #51). The automated suite, which
> drives a simulated app, is the current contract.

## Environment and policy

- macOS 26.7.3, Node.js 22.23.1.
- Antigravity desktop app 2.35.2 (`com.google.antigravity`), signed in; model as set in the app (Gemini 3.8 Flash Medium).
- Permissions preset `Turbo`, the user's own setting, unchanged throughout. No run changed a setting, a model or the preset.
- Accessibility granted to the host app (Claude), which started the runs; the runner sent no keystrokes.
- Project: the repository was already the app's `agybird` project.
- Prompts, replies and repository content are not reproduced here.

## Results

| Run | Through | Result | Time |
| --- | --- | --- | --- |
| Read task, reply `READY` | `scripts/desktop.mjs` | `success`, response `READY`, `changed_files` empty, Turbo warning | 13 s |
| `--json-schema`, 40 lines with tabs inside a fenced block | `scripts/desktop.mjs` | `success` twice, every line and tab intact in `structured_output` | 21–22 s |
| Write task creating one file | `scripts/desktop.mjs --mode write` | `success`, `changed_files` named the new file (removed afterwards) | 28 s |
| Read task | `companion.mjs task --via desktop` | `success`, job `transport: desktop`, no model picked | 15 s |
| Background task, cancelled after 12 s | `companion.mjs task --background`, then `cancel` | job `cancelled` with `stoppedAt`; the app showed no run afterwards | 12 s |
| Folder that is not a project | `scripts/desktop.mjs` | `blocked`, `no_project`, nothing touched | < 1 s |
| Lock held by a live process | `scripts/desktop.mjs` | `blocked`, `locked`, the lock left as it was | < 1 s |
| Review of a 138 KB working-tree diff | `companion.mjs review --via desktop --timeout 8m` | prompt pasted and sent whole; the app worked 8 minutes; at the deadline the runner pressed Stop and returned `error` with the timeout | 8 m |
| Review of one commit with a seeded bug (`=` for `===`) | `companion.mjs review --via desktop --scope branch --base HEAD~1` | `success`, verdict `needs-attention`, one `high` finding at the right file and line | 39 s |

In every run the clipboard and the app in front before the run were restored, and `~/.agybird/desktop.lock` was gone afterwards.

## Findings fixed during the check

1. Reading the composer right after Edit > Paste saw an empty input: the paste lands asynchronously. `paste-input` now reads until the text is steady.
2. `Send message` sometimes appeared a moment after the paste. `send` now waits up to 2 s for it.
3. A conversation opened while the app was in the background dropped the paste when the app came forward. The runner now brings the app forward before it opens the conversation.
4. Bringing the earlier app back through `NSRunningApplication` did not work; `restore` uses `open -b`.
5. The accessibility text of a reply is rendered Markdown split into words, without code fences. The reply is taken from the app's Copy button instead.
6. The composer's `AXValue` stops after a few thousand characters, so a review's prompt never read back whole. The read-back joins the composer's line nodes and compares every non-whitespace character in order (links are separate nodes).
7. A reply with a code block in another language before its JSON block paired the wrong fences. Fences are now read line by line.

## Not checked live

- A permission prompt and its approval: it needs the `Request Review` preset, which the runner never sets. The simulated app covers `needs_permission`, approval of option 1 and the refusal when the question changed.
- The preflight refusals `not_macos`, `app_missing`, `not_trusted`, `unsupported_version`, `labels_missing` and `ambiguous_project`, covered by the simulated app.
- The commands installed as a plugin in Claude Code or Codex, and hosts other than Claude.
