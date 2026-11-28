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

After the review fixes (approval transport, read mode at the prompt, conversation title, Copy check, cancel):

| Run | Through | Result | Time |
| --- | --- | --- | --- |
| Read task | `companion.mjs task --via desktop` | `success`, response `READY`, `evidence.conversation_title` named the run's conversation, reply taken through Copy | 19 s |
| Background task, cancelled while running | `companion.mjs task --background`, then `cancel` | `cancelled`, the app stopped, lock gone, front app back; `cancel` returned in 2 s | 2 s |

In every run the clipboard and the app in front before the run were restored, and `~/.agybird/desktop.lock` was gone afterwards.

## Findings fixed during the check

1. Reading the composer right after Edit > Paste saw an empty input: the paste lands asynchronously. `paste-input` now reads until the text is steady.
2. `Send message` sometimes appeared a moment after the paste. `send` now waits up to 2 s for it.
3. A conversation opened while the app was in the background dropped the paste when the app came forward. The runner now brings the app forward before it opens the conversation.
4. Bringing the earlier app back through `NSRunningApplication` did not work; `restore` uses `open -b`.
5. The accessibility text of a reply is rendered Markdown split into words, without code fences. The reply is taken from the app's Copy button instead.
6. The composer's `AXValue` stops after a few thousand characters, so a review's prompt never read back whole. The read-back joins the composer's line nodes and compares every non-whitespace character in order (links are separate nodes).
7. A reply with a code block in another language before its JSON block paired the wrong fences. Fences are now read line by line.
8. The window holds two `AXWebArea`s and only one carries the conversation title; reading the first made every run look like another conversation. The title comes from the titled one, and a poll with no title is skipped.
9. Cancel waited the whole kill grace: the worker's synchronous wait in `killTree` kept it from reaping the exited runner, so the group looked alive. A desktop runner now gets SIGTERM alone while the worker keeps reaping, and the group is killed only after 12 s.

## Not checked live

- A permission prompt and its approval: it needs the `Request Review` preset, which the runner never sets. The simulated app covers `needs_permission`, approval of option 1 in the conversation that asked, the refusals when the question, the conversation or option 1's label changed, and read mode declining a prompt after a change.
- The preflight refusals `not_macos`, `app_missing`, `not_trusted`, `unsupported_version`, `labels_missing` and `ambiguous_project`, covered by the simulated app.
- The commands installed as a plugin in Claude Code or Codex, and hosts other than Claude.
