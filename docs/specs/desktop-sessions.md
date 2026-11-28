# Desktop sessions: projects on demand and runs that do not wait for each other

Status: settled (owner decisions of 2026-11-28); implemented in finolabs/agybird#60 (not merged).
Evidence: `docs/verification/2026-11-28-desktop-spike-projects-sidebar.md` (F1–F9 below refer to it).

## Goal

A desktop run starts in any repository or worktree on this Mac without the user preparing a project, and two runs for different work no longer wait for each other while the agents work. The fixes the spike found in the current runner come with it.

## Settled decisions (Fio, 2026-11-28)

1. **Projects on demand, by default.** When no Antigravity project points at the run's folder, the runner creates one, as the CLI transport already does (F1). No flag is needed.
2. **A worktree gets its own project, named `<repo>-<worktree>`.** An existing project cannot run in a caller's worktree (F2), so the project's folder is the worktree itself. The name joins the main checkout's folder name and the worktree's folder name, for example `vibefront-architecture-constitution`; `-2`, `-3` and so on are added while the name is taken.
3. **Up to 5 desktop runs at once.**
4. **The result phase switches the conversation on screen without waiting.** It takes a few seconds; the user may see Antigravity's view change.

## Acceptance criteria

### Projects

- A1. A folder that a project already points at (exact `folderUri` or `gitFolder.folderUri`, as `findProjectForWorkspace` matches today) uses that project; nothing is created.
- A2. A folder with no project gets one, written as `ensureProject` writes it, before the app is touched; the envelope's evidence says `project_created: true` and names it.
- A3. The new project's name is unique among all project files: the folder name for a main checkout, `<repo>-<worktree>` for a linked worktree (the repo name from the worktree's common Git directory), then `-2`, `-3`… The runner never renames or edits a project it did not create.
- A4. Two existing projects with the run's name still end `blocked: ambiguous_project`; the runner does not resolve them.
- A5. The project picker selects the new project by its exact name on the same run (F1); if the app does not list it, the run ends `blocked: project_not_listed` with nothing pasted.

### Runs that do not wait for each other

The app lock (`~/.agybird/desktop.lock`) is held only while a run acts on the app. Three phases:

- B1. **Start, under the lock:** the idle wait, the clipboard, the switch to the app, the new conversation and its project, the paste, giving the front and the clipboard back, the read back, Send, and binding the run's conversation by title and marker. The lock is held until the title has settled: the 2.36 rename after Send (or 15 s with no rename). Then it is released.
- B2. **Wait, with no lock:** the runner reads its row in the sidebar (title and project, F3) every poll. `In Progress` keeps waiting. `Blocked` and `Idle` go to B3. A row missing from the sidebar (or a read that fails) for 3 polls in a row ends the run `error`; Stop is then pressed only in the run's own conversation, checked by title and marker, as on any other error. Only the one `Sidebar` group is read, so a conversation's text shaped like a row or a heading is never taken for one.
- B3. **Result, under the lock:** the runner opens its conversation from the sidebar (F4), checks the title and its own marker in the same read as today, and only then reads: a dialog (`needs_permission`, or `blocked: agent_question` of C3), or the reply through Copy. The lock is released at once. Stop on timeout or cancel, and an approved answer, run under the lock the same way.
- B4. At most 5 runs are between B1 and the end of B3 at once; a sixth ends `blocked: too_many_runs` before touching the app. Each live run has its own record (`~/.agybird/desktop-runs/<marker>.json`: pid, marker, project, title, deadline, and from Send on `app`, that the app may run its task), written whole through a rename. A record whose process is gone and that has no `app` is removed; one with `app` counts among the five until the sidebar shows its conversation alone under `Idle`, or the user removes it. A run that holds the app when it cannot press Stop keeps the lock as today; one that waits with the app free keeps its record instead. Projects are created under the lock, after the count.
- B5. The switch of the conversation on screen in B3 does not wait for the user (decision 4), but the app is never brought to the front for it.

### Fixes from the spike

- C1. A `front` that leaves the app behind ends the run before the conversation opens: `error` "Antigravity did not come to the front", nothing pasted (F7).
- C2. A paste refused before it pastes (`not_frontmost`, `not_found`, `other_conversation`, `truncated`) counts as not pasted: no "left unsent" warning, no clearing (F7).
- C3. A dialog that is an agent question, not a permission prompt (its option 1 is not "1 Yes, allow this time"), ends the run `blocked: agent_question` with the question and its options in `evidence.agent_question`; it is never answered by the permission flow (F6). A blocked reason, not a new envelope status, keeps the public statuses unchanged.
- C4. A turn ends only when the sidebar shows no row of the run's title `In Progress` and the conversation read in B3 shows a reply with no run going; an interim message while the row is `In Progress` is never returned (F5). A failed sidebar read, or no row, decides nothing.

## Out of scope

- Talking to the app's language server instead of its window (the hub API spec).
- Changing the permissions preset, the model, the branch or where the agent runs.
- Archiving or deleting conversations or projects the runs leave behind.

## Risks and how the criteria hold them

| Risk | Held by |
| --- | --- |
| Two runs' conversations share a title in one project | B3 reads the marker in the same read as the title; a namesake is never read or pressed, and the runner tries the next row with that title before ending `error`. |
| The sidebar's grouping changes (Display Options, a later version) | No `In Progress`/`Blocked`/`Idle` heading in the sidebar keeps the run on screen under the lock, deciding the turn by today's on-screen polling (no `sidebar_unreadable` stop: the app works without the groups, only without parallel runs). |
| A namesake (same title, same project) is `In Progress` | The run's turn ends only when no row of its title is `In Progress`, so the namesake delays it, at worst to the timeout; it never returns an interim message. |
| A run killed in B2 leaves its task going | Its record stays with `app`; it counts among the five until the sidebar shows the conversation alone under `Idle`, or the user removes it. |
| Created projects pile up | Only one per folder; `project_created` in the evidence says which. Cleanup stays the user's (out of scope). |

## Proof

- Simulated app: the fake bridge gains the sidebar (rows with headings), project creation, and two runs interleaving B1/B2/B3; tests for A1–A5, B1–B5, C1–C4.
- Live on 2.36: a run in a folder with no project, a run in a worktree, two runs in different projects started 10 s apart, both ending `success` with their own replies, and the `sleep 40` task returning its real reply.
