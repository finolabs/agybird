# Live Desktop Transport Verification — macOS — Antigravity 2.36.0 — 2026-11-28

> **Snapshot, not current behaviour.** This records what was observed on 28 November
> 2026 while adding Antigravity 2.36 support. The automated suite, which drives a
> simulated app of both layouts, is the current contract.

## Environment and policy

- macOS 26 (Darwin 25.6.0), Node.js 22.
- Antigravity desktop app 2.36.0 (`com.google.antigravity`), auto-updated from 2.35, signed in; model as set in the app.
- Permissions preset `Turbo`, the user's own setting, unchanged throughout. No run changed where the agent runs, the branch, a model or the preset.
- Accessibility granted to the host app (Claude), which started the runs; the runner sent no keystrokes.
- Project: the repository is the app's `agybird` project; the app also lists near-names (`agybird-wt-agy`, `pin-agybird-0-4-5`, `agybird-codex-task-2`, `agenger-agybird-preflight-…`).
- Prompts, replies and repository content are not reproduced here.

## What changed in the app (read-only accessibility dumps)

1. The sidebar no longer lists projects with `New Conversation in Project`. One `AXLink "New Conversation"` opens an untitled conversation whose composer has `Where the agent runs, current: This Computer`, `Select project, current: <name>` and `Branch, current: main` pop-ups.
2. Pressing `Select project` opens an `AXMenu` with `Search Projects` and one `AXMenuItem "<name> Project Settings"` per project (the name as its own text, then a `Project Settings` button). The list is virtualized; setting the search field's `AXValue` filters it at once. Pressing the item sets the picker to `current: <name>`.
3. A running turn shows an `Agent working` heading and a `Cancel (⌃C)` button in the composer; there is no `Stop execution`.
4. A reply spans several groups after `Agent said` (the time worked, the text, lists, a diff summary) before `Response actions`.
5. The sent message is collapsed behind `Expand message`; its whole text, marker line included, is one static text's `AXValue`.
6. The app titles a new conversation with the prompt's first line, then renames it within about two seconds (for example to `Agybird CLI Ready Check - agybird - Antigravity`).
7. The sidebar now lies inside the titled conversation web area.

## Results

| Run | Through | Result | Time |
| --- | --- | --- | --- |
| Read task, reply `READY`, before the rename fix | `scripts/desktop.mjs` | project picked (`current: agybird`), pasted and sent; after Send the run bound the first title, then saw the renamed one and ended `error` ("another conversation"), keeping the lock for the app. The app had answered `READY`. | 13 s |
| Read task, reply `READY`, with the rename fix | `scripts/desktop.mjs` | `success`, response `READY` through Copy, `conversation_title` the renamed title, `changed_files` empty, Turbo warning only; the lock the first run kept was freed by evidence (its renamed conversation shown with its marker and no run) | 16 s |
| Review of one commit (the 0.4.7 version bump, 9 files) | `companion.mjs review --via desktop --cwd <repo> --base HEAD~1 --wait` | `success`, verdict `approve`, no findings, structured output parsed from the last fenced JSON block | 2 m 30 s |
| Background task, then `cancel` (twice) | `companion.mjs task --via desktop --background` | `error` `not_frontmost` at paste, nothing pasted or sent, clipboard and front app restored, lock released. A front-app log showed another app (Chrome, in use at the time) coming back to the front about 1.7 s after the runner brought Antigravity forward. A foreground read task run at the same time failed the same way. Not a 2.36 change; fail closed as designed. | < 10 s |

In every run the clipboard and the app in front before the run were restored, and `~/.agybird/desktop.lock` was gone afterwards, except after the first run, as described.

## Findings fixed during the check

1. The 2.36 rename after Send ended every run `error` and kept the lock. A bound conversation is now followed to a new title of the same project in a read that shows the run's own message with its marker; the evidence that frees a kept lock accepts the renamed conversation the same way.
2. The 2.36 running state (`Cancel (⌃C)`, `Agent working`) and the multi-group reply, seen in the dumps, are read; Stop presses `Cancel (⌃C)`.

## Observed, not changed

- On 2.36 the reply the app's Copy button writes includes its tool-step lines (`Analyzed <file>`) before the answer. The review's JSON block is still the last fenced block and parsed whole.

## Not checked live

- Cancelling a running 2.36 task (pressing `Cancel (⌃C)`): both attempts failed closed at paste because another app took the front. The simulated app covers it.
- A permission prompt and its approval on 2.36 (needs the `Request Review` preset, which the runner never sets). An approval after a rename is refused (the title differs) and is answered in the app instead.
- The refusals on 2.36 for a near-name only, `Where the agent runs` other than `This Computer`, or a picker that does not change; covered by the simulated app.
