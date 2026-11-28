# Desktop projects on demand, checked live (2026-11-28)

macOS 26 (Darwin 25.6), Antigravity 2.36.0, preset `Turbo`, branch `feat/desktop-projects-on-demand`.

| Check | Result |
| --- | --- |
| Read task in a new repository no project pointed at | `success`, `READY`; `evidence.project_created: true`, project `live-a-repo`, conversation "… - live-a-repo - Antigravity". |
| Read task in a linked worktree of it (`feat-x`) | `success`, `READY`; project `live-a-repo-feat-x`, its folder the worktree. |

Both projects were removed afterwards. The agent-question path (`blocked: agent_question`) was seen live in the spike (F6) before the fix and is covered by the simulated app after it.
