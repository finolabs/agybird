# Spike: projects, worktrees and the sidebar on Antigravity 2.36 (2026-11-28)

macOS 26 (Darwin 25.6), Antigravity 2.36.0, preset `Turbo`, agybird 0.4.8. Every read below is an Accessibility read with the app behind, unless the row says the app came to the front.

## Findings

| # | Question | What was done | Result |
| --- | --- | --- | --- |
| F1 | Does a running Desktop see a project created outside it? | `ensureProject` (the CLI transport's own function) wrote `agybird-<uuid>.json` for a new scratch repository while the app ran; then a desktop read task ran there. | The project picker found it by its exact name with no restart; the task answered `READY`. 127 of the 149 projects on this Mac were written this way by the CLI transport. |
| F2 | Can an existing project's conversation run in an existing worktree? | Opened a new conversation in project `agybird` and read the `Branch` picker. | It lists the repository's branches and "Work in a New Worktree (Keeps your checkout untouched)". A branch checked out in another worktree is listed as "Checked out in <path>" with `AXEnabled` false: it cannot be chosen. "Work in a New Worktree" makes a worktree Antigravity manages, not the caller's. So a caller's worktree needs a project whose folder is that worktree. |
| F3 | Does the sidebar show each conversation's state? | Sampled the sidebar every 3–6 s during a 40 s task and during an agent question. | Rows sit under status headings: `In Progress` while the agent works, `Blocked` while it waits for the user, `Idle` once done. Each row is an `AXLink` with the title, then the project name. A running row has no age text. |
| F4 | Can a conversation be opened without the front? | `AXPress` on a sidebar row with the app behind. | The view switched to that conversation; the front app did not change; its reply read whole. |
| F5 | Is the current end-of-turn detection sound? | A task that runs `sleep 40` in the terminal. | The runner returned `success` with an interim message ("Running sleep 40 seconds… Waiting for") while the sidebar still showed `In Progress`; the real reply ("…SPIKEDONE") came 40 s later. |
| F6 | How does an agent question look to the runner? | A prompt asking the agent to ask the user to pick a color. | The sidebar moved to `Blocked`; the runner reported `needs_permission` with the question read as "1 Red 2 Blue 3". |
| F7 | Why did a huly-skill run report a prompt "left unsent"? | Code read of `scripts/desktop.mjs`. | `front` returning `ok: false` is not checked, and `pasted` is set before `paste-input`, whose `not_frontmost` refusal comes before the paste; the warning was false and the composer stayed empty. |
| F8 | Do web popup menus answer in the background? | `AXPress` on a `Branch` item with the app behind, then in front. | Behind: no effect, the menu stays open. `AXCancel` does not close it either; it closed when the app came forward. |
| F9 | Why did one project's run wait for another project's run? | Two sessions (huly-skill, vibefront). | The lock is machine-wide and held from the switch to the app until the turn ends, because the runner reads the turn from the conversation on screen. |

## Not checked

- A permission prompt under `Request Review` (the runner never changes the preset); F6 shows the same `Blocked` heading for a question.
- Two runs at once; the design that would allow it is in `docs/specs/desktop-sessions.md`.
- Whether the sidebar groups stay on when its Display Options change.

Test leftovers: conversations "Agybird Spike Task Ready", "Run Sleep Command And Reply" and "Agybird CLI Task Setup" (waiting for a color) in the app; the scratch project file was removed.
