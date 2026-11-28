# Desktop runs in parallel, checked live (2026-11-28)

macOS 26 (Darwin 25.6), Antigravity 2.36.0, preset `Turbo`, branch `feat/desktop-projects-on-demand`.

Run A in `agybird` ran `sleep 30`, then answered ALPHA. Run B, started 10 s later in a new repository with no project, ran `sleep 15`, then answered BRAVO.

| Time | App lock | Run records |
| --- | --- | --- |
| 16:13:46 | held (A starting) | 1 |
| 16:13:49 | held (B waits for A, then starts) | 2 |
| 16:14:04–16:14:38 | free: both agents working | 2 |
| 16:14:38 | held (B reads its result) | 2 |
| 16:14:41 | held (A reads its result) | 1 |
| 16:14:44 | free | 0 |

Both runs ended `success` with their final replies, "…ALPHA" and "…BRAVO", not the interim "Running sleep…" message the runner returned before the sidebar check. B finished at 16:14:39, before A at 16:14:43. B's project `live-b-repo` was created on the run and removed afterwards.

A first attempt showed the sidebar read must use the conversation's own name, not the window title ("<name> - <project> - Antigravity"): with the window title no row matched, so neither run released the app and both returned interim messages. Fixed before the run above.
