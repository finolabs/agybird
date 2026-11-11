# Agybird companion: commands, background jobs and a review gate
Status: in progress; plan approved by Fio on 2026-11-11

Make Agybird a full companion for Antigravity CLI (`agy`) inside Claude Code and Codex, on par with OpenAI's `codex` plugin for Claude Code (1.0.6, Apache-2.0, read for its surface only; no code copied), and better where Agybird already is: quota-aware model choice across the Gemini and the Claude and GPT pools, the permission round trip, structured output and image work. Then prepare a submission to Anthropic's plugin directory.

## Decisions

Settled with Fio on 2026-11-11:

- D1 Scope: parity with `codex` including the opt-in Stop review gate: review, adversarial review, rescue (task delegation), status, result, cancel, setup, plus `usage` and `image`. Session transfer stays out of this record.
- D2 Hosts: Claude Code and Codex. Antigravity keeps today's single skill, since delegating from `agy` to `agy` has no use.
- D3 Listing: Claude drafts the directory submission; Fio submits it from his own claude.ai account in the developer portal.
- D4 Images: the directory policy (§4B) excludes AI image generation, so the repository gains a directory edition in its own plugin folder without any image capability. The finolabs catalog keeps the full plugin. A CI check keeps the shared files of both editions identical.

Settled from the evidence, no owner decision needed:

- D5 Codex plugins have no slash commands or custom subagents (Codex "build plugins" docs, read 2026-11-11), so each command is a Codex skill. Claude Code gets `commands/` and an agent. Both call one shared companion script.
- D6 Codex runs plugin hooks only for manually installed plugins the user trusts. Its hooks receive `PLUGIN_ROOT` and, for compatibility, `CLAUDE_PLUGIN_ROOT`, and read the same Stop input and `{"decision":"block","reason":...}` output (Codex hooks docs, read 2026-11-11), so both hosts share `hooks/hooks.json`. Revised 2026-11-11 from the first plan of a separate Codex hooks file.
- D7 `agy --settings` replaces the global allow list (verified on `agy` 1.5.5), so grants keep using the project file, journal and lock.

Open, owned by Fio:

- O1 Version. `fnl-versioning` makes a compatible feature release in phase 0 a PATCH (`0.4.2`); `1.0.0` needs Fio's decision. Unblocks: release step.
- O2 Directory review needs a test account (§3D) and proof that the submitter controls connected endpoints (§3F); `agy` needs the reviewer's own Google plan and talks to Google, so the listing may be refused. Owner: Fio at submission time. This work prepares the strongest case and does not block on it.

## Goal and acceptance

- [ ] AC1 `/agybird:review [--base <ref>] [--scope auto|working-tree|branch] [--wait|--background]` runs a read-only `agy` review of the chosen diff and prints findings with severity, file and line from a JSON schema; it changes no file (git state identical before and after).
- [ ] AC2 `/agybird:adversarial-review` runs the same scope with a prompt that challenges the design and assumptions, in the same output format.
- [ ] AC3 `/agybird:rescue <task>` hands a task to `agy` through an `agybird-rescue` subagent in Claude Code and an `agybird-rescue` skill in Codex, read mode unless the task asks for changes, resuming the workspace conversation unless `--fresh`; `needs_permission` is shown to the user and nothing is granted without their answer.
- [ ] AC4 `--background` on review, adversarial review and rescue returns a job id at once; `/agybird:status [job]`, `/agybird:result [job]` and `/agybird:cancel [job]` list, show and stop jobs of the current workspace, and a cancelled or crashed job ends `cancelled` or `failed`, never `running` forever.
- [ ] AC5 `/agybird:setup` reports `agy` presence and version, sign-in, the quota pools and the review gate state, and installs nothing; `--enable-review-gate` and `--disable-review-gate` switch the gate for the current workspace only.
- [ ] AC6 With the gate on, the Stop hook reviews the turn's working-tree changes; it blocks the stop with the findings when one is MEDIUM or worse, lets it pass when there are none or no changes, never blocks twice in a row (`stop_hook_active`), and fails open with a notice when `agy` is missing, out of quota or past the time limit. With the gate off it starts no `agy` process.
- [ ] AC7 `/agybird:usage` shows each pool's five-hour and weekly remaining share and reset time in local time, and the model each tier would use now; review and rescue pick a model from it when the user names none, never moving up a tier silently.
- [ ] AC8 `/agybird:image` generates or edits an image and verifies the artifact as the skill does today (full edition only).
- [ ] AC9 The same commands work as Codex skills (`$agybird-review` and the rest) from `.codex-plugin`, and the Codex hook file runs the same gate.
- [ ] AC10 The directory edition passes `claude plugin validate --profile directory --strict`, contains no image capability, no `.DS_Store`, no lockfile install, and every file it runs inside its folder; CI fails when its shared files differ from the full edition.
- [ ] AC11 README, PRIVACY, threat model and in-plugin help say what each command and the gate send to Google through `agy`, what is stored and where, and that Agybird is unofficial; directory listing fields (`icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`) point at files in the public repository.
- [ ] AC12 The runner's envelope contract and existing behaviour are unchanged; its only change is the additive `--no-record` flag (with `--new-session`), and existing tests change only to list that default.

## Plan

Architecture:

- `scripts/agybird.mjs` stays the only process that runs `agy` for work and keeps its envelope. A new `scripts/companion.mjs` is the command layer: argument parsing, git scope, prompt and schema selection, model choice from quota, job store, rendering. It calls the runner as a child process with stdin, never a shell.
- Job store: one JSON file per job plus a log under `${CLAUDE_PLUGIN_DATA}` or `${PLUGIN_DATA}` when set, else `~/.agybird/jobs/`, keyed by workspace. A background job is a detached `companion.mjs run-job <id>`; status checks the recorded pid and start time, so a dead process becomes `failed`. Cancel kills the job's process tree (`taskkill /T /F` on Windows). A job that needs a grant stops at `needs_permission`; grants run in the foreground only, as today.
- Review: scope from git (working tree, or `--base` branch diff, `auto` picks); diff and file list bounded in size; `--json-schema` with a findings schema; read mode; output rendered as Markdown. The adversarial prompt is a separate template.
- Gate: `hooks/hooks.json`, shared by Claude Code and Codex, calls `companion.mjs hook stop`. Per-workspace config holds the on/off switch; default off.
- Hosts: Claude Code `commands/*.md` and `claude-agents/agybird-rescue.md` (named in `.claude-plugin/plugin.json`, outside the `agents/` folder Antigravity scans) call the companion; the root `SKILL.md` stays the general delegation skill. Codex skills live in `.codex-skills/` (the adapter plus one skill per command) and `.codex-plugin/plugin.json` points there; `.antigravity-plugin` keeps `.plugin-skills/agybird` only.
- Directory edition: `directory/agybird/` with its own `.claude-plugin/plugin.json`, README, LICENSE, commands, agent, hooks and a copy of the scripts without image handling; `scripts/check.mjs` compares the shared files.

Seams and consumers:

- Runner `scripts/agybird.mjs`: consumers are the root skill, the companion and the tests; changes limited to what the companion needs (none planned).
- Manifests: release workflow version check, plugin-contract and install-layout tests, the finolabs catalog check (description and keywords must match all three manifests).
- `.plugin-skills/` and `.codex-plugin`: Codex installs, install-layout test, README install section, migration notes.

Order: US1 job core, US2 review, US3 rescue/setup/usage/image, US4 gate, US5 Codex skills, US6 directory edition and docs, US7 release and submission pack. Each story ends with its targeted tests and the review gate before the next starts.

Risks: Stop hook spends quota on every gated stop (default off, lighter model, time limit); background processes outliving sessions (pid and start-time checks, cancel); the directory may refuse the listing (O2); Codex hook trust is manual.

## Tasks

### US1
- [x] T1 Job store, ids, pid liveness and cancel, with unit tests on the fake `agy`
- [x] T2 `status`, `result`, `cancel` commands and rendering

### US2
- [x] T3 Git scope resolution and bounded diff collection
- [x] T4 Review schema, prompts and `review` / `adversarial-review` commands, foreground and background

### US3
- [x] T5 `rescue` command, `agybird-rescue` agent and resume or fresh session
- [x] T6 `setup` and `usage` with quota-based model choice
- [x] T7 `image` command over the existing image category

### US4
- [x] T8 Stop hook gate with loop guard, fail-open and per-workspace switch

### US5
- [x] T9 Codex skills folder, manifest hooks override, install-layout tests

### US6
- [x] T10 Directory edition folder, listing fields, parity check in CI
- [x] T11 README, PRIVACY, threat model and help updated against what ships

### US7
- [ ] T12 Release per O1, catalog pin, directory submission pack for Fio

## Evidence

US1 (T1, T2), head 5510ef7: jobs.test.mjs 9/9, companion.test.mjs 10/10, plugin-contract + install-layout 15/15 (Node 26, macOS). `scripts/lib/jobs.mjs` was written before its tests; every later change started from a failing test. Codex read-only review: round 1 on 71f099c REWORK (code: cancel overwritten, cancelled job started, process tree not ensured; security: `$ARGUMENTS` in inline shell, pid reuse), round 2 on 1b20ac3 REWORK (claim-to-spawn window, stale job uncancellable, heartbeat not proof of identity), round 3 on 5670eee code REWORK (stoppedAt after a failed registration) and security APPROVE; with Fio's go for a third round, 5510ef7 code APPROVE and security APPROVE. Disposition: a runner whose worker died is reported with its pid, never signalled; the renderer written ahead of US2 was kept.

US2 (T3, T4), head ea6f04a: scope.test.mjs 16/16, review.test.mjs 7/7, runner.test.mjs 24/24, arguments.test.mjs 7/7, companion.test.mjs 10/10, docs-contract 6/6, skill-contract 7/7 (Node 26, macOS). Live: one review on agy 1.5.5 with gemini-3.8-flash-low returned success with a HIGH and a MEDIUM finding on the right lines in 38s and left git status unchanged. Codex read-only review: f07723f code and security REWORK (unbounded collection, unborn repository, --wait; separate state folder split grant locks, textconv/fsmonitor helpers, symlinks followed); 55559b8 code APPROVE, security REWORK (configured clean/process filters); 664b9b2 code REWORK (last cut file not flagged), security REWORK (failed filter listing trusted); with Fio's go, 1ca9196 code REWORK (--attr-source needs git 2.41), security APPROVE; ea6f04a code APPROVE, security APPROVE. The runner gained one additive flag, --no-record.

US3 (T5, T6, T7), head aa6ff01: quota 9/9, approvals 5/5, commands 14/14, companion 10/10, review 7/7, plugin-contract 14/14 (Node 26, macOS). Live on agy 1.5.5: usage read the real pools; a task with no --model ran on claude-sonnet-5-5-medium in 16s. Codex read-only review: 31f7944 code REWORK (unknown quota read as spent, setup hid pools) and security REWORK (rule spliced into shell, approval from rendered prose); fb927ee code REWORK (retry lost write mode) and security REWORK (approval not bound to its conversation); a4eeadd code REWORK (image approval resumed as code) and security REWORK (no negative tests for approval flags); with Fio's go, 56632d8 code REWORK (image references dropped), security APPROVE; aa6ff01 code APPROVE, security APPROVE. Raw --grant left the companion: approvals name a stored request (--approve <job>:<n>) and resume its own conversation, mode, category, model and references.

US4 (T8), head 15e91d2: gate 11/11, scope 16/16, review 8/8, commands 14/14, companion 10/10, quota 9/9, jobs 9/9 (Node 26, macOS). Live on agy 1.5.5: the first gate run ended blocked because the model tried a terminal grep, and the hook failed open with a notice; after the prompts told Antigravity not to run commands, the gate blocked the stop in 19s with a MEDIUM finding on the right line. Codex read-only review: 34689fd code REWORK (no overall deadline, default-model fallback, successive template replacement) and security REWORK (a file named {{DIFF}} escaped its block); 7431b3e code REWORK (unbounded workspace lookup before the deadline, timer left on rejection), security APPROVE; 15e91d2 code APPROVE, security APPROVE.

US5 (T9), head 438baef: codex-skills 5/5, plugin-contract 14/14, install-layout 1/1; claude plugin validate --strict and --profile directory passed; agy plugin validate loads 1 skill and 0 agents. Codex read-only review: code APPROVE (one LOW, the stale agent path in this record, fixed here) and security APPROVE on the first round. Not verified: a real Codex install of the skills and the shared hook.

US6 (T10, T11), head 4d57782: directory-edition 6/6, gate 11/11, commands 14/14, companion 10/10, approvals 5/5, codex-skills 5/5, plugin-contract 14/14, arguments 7/7, image-artifacts 9/9, runner 24/24, docs-contract 6/6, skill-contract 7/7, install-layout 1/1 (Node 26, macOS); claude plugin validate directory/agybird --profile directory --strict passed; root validators unchanged. Codex read-only review: c392eeb code REWORK (CRLF checkouts read the edition as stale), security APPROVE with two LOW disclosure gaps; 4d57782 code APPROVE, security APPROVE. The full suite (npm run check) was not run locally.

