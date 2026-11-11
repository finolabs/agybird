# Agybird

![Agybird — Delegate work to the Antigravity CLI you already use.](assets/wordmark.svg#gh-light-mode-only)
![Agybird — Delegate work to the Antigravity CLI you already use.](assets/wordmark-dark.svg#gh-dark-mode-only)

[![release](https://img.shields.io/github/v/release/finolabs/agybird)](https://github.com/finolabs/agybird/releases/latest)
[![CI](https://github.com/finolabs/agybird/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/finolabs/agybird/actions/workflows/ci.yml)

Agybird is an MIT-licensed Agent Skill that lets Claude Code and Codex delegate work to the official Google Antigravity CLI (`agy`). It uses the user's existing Antigravity authentication and Gemini subscription instead of extracting credentials or calling private APIs.

Agybird is unofficial and is not affiliated with Google.

## What it covers

- **Code:** read-only review or scoped implementation, followed by independent diff and test verification.
- **Image:** new image generation and reference-image editing through Antigravity's built-in `image-generator` subagent and its `generate_image` tool, followed by artifact and visual verification.
- **General:** read-only analysis by default, structured JSON output, or explicit deliverable creation.

This is an Agent Skill, a small local runner and a set of [commands](#commands), not an MCP server. Claude Code or Codex remains the orchestrator; `agy` remains the authenticated provider process.

## Requirements

- Node.js 20 or newer.
- The [official Antigravity CLI](https://antigravity.google/docs/cli/install), installed and authenticated by running `agy` interactively.
- A Google account and Antigravity plan that is eligible for the requested capability.
- Last checked live with `agy` 1.5.5 on macOS: a read-only run, an expired timeout, and the commands' review, a task with automatic model choice, usage and the review gate. Image, write and permission-grant runs were last checked live on earlier `agy` releases, and in an installed Claude Code only `/agybird:setup` has run so far (0.4.2, through `command node`); the other commands and Codex have not been checked installed. CI runs the suite on Linux, macOS, and Windows against a simulated `agy`, so a newer CLI that changes its JSON stream can break the runner until a release catches up.

Google continues to enforce subscription eligibility, quota and credit availability, permissions, sandbox configuration, and generated-content policy. Agybird does not bypass any of them.

## Install

Every install path ships the same skill from the same files. Pick the plugin path for your agent to get versioned updates, or the Skills CLI for a plain skill install.

### As a Claude Code plugin

Agybird is listed in the shared [FINOLABS catalog](https://github.com/finolabs/plugins). Add the catalog, then install the plugin:

```bash
claude plugin marketplace add finolabs/plugins
claude plugin install agybird@finolabs
```

Update the catalog with `claude plugin marketplace update finolabs`. This path requires Claude Code v2.1.142 or newer. This repository no longer hosts its own marketplace, so a plugin installed as `agybird@agybird` gets no further updates: remove it and install `agybird@finolabs`.

### As a Codex plugin

```bash
codex plugin marketplace add finolabs/plugins
codex plugin add agybird@finolabs
```

Start a new session afterwards so the skill loads. Refresh the catalog with `codex plugin marketplace upgrade finolabs`, then run `codex plugin add agybird@finolabs` again. Codex caches each plugin by the version in `.codex-plugin/plugin.json`.

**Installed from the older `Finolabs` catalog (`agybird@Finolabs`)?** That catalog was served from this repository and is gone. Follow the [migration guide](docs/migration.md) before adding `finolabs/plugins`, because both names share one plugin cache folder on macOS.

### As an Antigravity plugin

Antigravity resolves `plugin@marketplace` only for its official marketplace, so install from the repository URL:

```bash
agy plugin install https://github.com/finolabs/agybird
```

Check it with `agy plugin list`. There is no catalog to upgrade from, so run the install command again to pick up a new release.

### As an Agent Skill

Use the interactive installer and select Claude Code, Codex, or both:

```bash
npx skills add finolabs/agybird
```

For an explicit global install into both agents:

```bash
npx skills add finolabs/agybird --global --agent claude-code codex
```

The command uses the open-source [Skills CLI](https://github.com/vercel-labs/skills). Review its prompt before confirming destinations.

## Use

Agybird triggers only when the request explicitly mentions Agybird, `agy`, Antigravity CLI, or using the Gemini subscription through Antigravity. Examples:

```text
Use agy to review this repository read-only and cite the lines behind each finding.
```

```text
Use my Gemini subscription through Antigravity CLI to generate a minimal blue-bird image, then inspect the artifact visually.
```

```text
Ask agy to summarize docs/ as JSON with summary and risks. Do not write files.
```

The skill chooses a category and invokes `scripts/agybird.mjs` with the prompt on stdin. The runner emits one JSON envelope whose status is `success`, `partial`, `needs_permission`, `blocked`, or `error`.

One objective stays in one Antigravity conversation. The runner records the workspace's conversation and resumes it on the next invocation, so a follow-up continues where the last one stopped instead of paying to rediscover it; `evidence.session_resumed` reports whether that happened, and `--new-session` starts a new objective deliberately.

When headless `agy` denies an action it cannot prompt for, `needs_permission` carries a `permission_requests[]` entry naming the tool, the exact target, and the allow-rule that would authorize it, so the caller can ask the user instead of guessing at configuration. After the user approves, `--grant <rule>` applies it to the session being resumed; `--grant-scope once` (the default) removes it again when the run ends, and a rule left behind by an interrupted run is removed by the next one.

Because Antigravity applies a granted rule to every conversation in that project, a run on a *different* conversation in the same workspace returns `error` while a grant is live, rather than quietly inheriting it. Retry once the other run finishes.

## Commands

The plugin also adds commands that run through `scripts/companion.mjs`. In Claude Code they are slash commands; Codex has no plugin slash commands, so there each one is a skill you call by name.

| Claude Code | Codex | What it does |
| --- | --- | --- |
| `/agybird:review` | `$agybird-review` | Read-only review of the working-tree changes, or of the branch against `--base`, with findings by severity, file and line. |
| `/agybird:adversarial-review` | `$agybird-adversarial-review` | The same scope, but challenging the design, assumptions and tradeoffs. |
| `/agybird:rescue` | `$agybird-rescue` | Hands a task to Antigravity, read-only unless you pass `--write`, resuming the repository's conversation unless `--fresh`. |
| `/agybird:status`, `/agybird:result`, `/agybird:cancel` | `$agybird-status`, `$agybird-result`, `$agybird-cancel` | List, show and stop jobs; review and rescue take `--background`. |
| `/agybird:usage` | `$agybird-usage` | Quota per pool with local reset times, and the model each tier would use now. |
| `/agybird:setup` | `$agybird-setup` | Checks `agy` and its sign-in, and switches the review gate for one repository. |
| `/agybird:image` | `$agybird-image` | Generates an image, or edits `--reference` images. |

Review and rescue pick their model from Antigravity's own quota report when you name none: the usable model of the tier with the most room. When that tier has no quota left, the command stops and shows the reset times instead of moving to a more expensive tier.

A permission Antigravity asks for is never granted for you. `/agybird:rescue` reads the request from the stored result, asks you, and on a yes resumes the same conversation with that one rule (`--approve <job>:<n>`).

**Review gate.** `/agybird:setup --enable-review-gate` turns on a Stop hook for that repository: when Claude Code ends a turn with uncommitted changes, Antigravity reviews them read-only on a light-tier model, and a finding of medium severity or worse sends Claude back once to fix it or explain. It is off by default, spends quota on every gated turn, never blocks twice in a row, and lets the turn end with a notice when `agy` is missing, out of quota or slower than 12 minutes. Codex runs it only after you review and trust the plugin's hooks.

## Data and network

Agybird has no server, analytics, or telemetry. The runner starts one local `agy` process per invocation and talks to nothing else: it sends the task on standard input, reads `agy`'s JSON stream, and prints one envelope. Everything `agy` does with the task, including reading workspace files, fetching URLs, and generating images, happens in Google's CLI under the user's own Google account and Antigravity settings. Outside the workspace the runner writes only `~/.agybird/sessions/` (workspace path and conversation id, never prompts or results), small grant lock files under `~/.agybird/grant-locks/` (one per approved grant, marked released when it ends) and a record per running run under `~/.agybird/active-runs/`, with process and conversation ids only. The commands also keep a job store, in the plugin's data folder or `~/.agybird/jobs/`, holding each job's prompt, result and log, a five-minute quota cache, and the review gate switch. Reviews read `git` themselves and send the diff, and the gate also sends Claude's last message of the turn. See [PRIVACY.md](PRIVACY.md).

## Safety defaults

- Read-only unless the user requests a file-changing outcome.
- No token, keychain, browser-session, or private-endpoint access.
- No shell execution inside the runner and zero runtime dependencies.
- No `--dangerously-skip-permissions`.
- No change to the saved `useG1Credits`, model, effort, agent, or sandbox settings. The model is chosen per run by task and remaining quota; see [model selection](references/models.md).
- Image success requires a completed tool event and a real nonempty artifact in the working directory or the matching Antigravity conversation artifact directory.
- Reviews never let `git` start a program the repository configures: fsmonitor, textconv, external diff and filter drivers are switched off while the diff is collected.
- Commands run only when you call them; the review gate runs only where you switched it on.

See the [threat model](docs/threat-model.md), [security policy](SECURITY.md), and [official Antigravity overview](https://antigravity.google/docs/cli/overview).

## Develop

```bash
npm ci
npm run check
```

`directory/agybird/` is the edition submitted to Anthropic's plugin directory, whose policy excludes AI image generation: the same plugin with every `// agybird:image-start` region removed. It is generated, never edited by hand; run `node scripts/build-directory-edition.mjs` after changing a shared file, and the test suite fails while it is out of date.

Tests use a fake provider process and require no Google credentials. Live tests are manual and must never run in public CI.

The optional live wrapper refuses to spend credits unless `AGYBIRD_LIVE_CONFIRM=1` is set for that invocation. It still preserves the current Antigravity model, sandbox, permissions, and `useG1Credits` setting.

The automated suite is the current contract. Two earlier reports are kept as dated snapshots: [deterministic verification](docs/verification/2026-08-02-simulated.md) and [live macOS verification with `agy` 1.1.9](docs/verification/2026-08-02-live-macos.md). Both predate the permission and session work, so they record a denial as `blocked` where the runner now reports `needs_permission`. They are history, not a description of current behaviour.

## License

[MIT](LICENSE). Use of Google Antigravity remains subject to [Google's Antigravity terms](https://antigravity.google/terms). See [PRIVACY.md](PRIVACY.md) for where delegated data goes and [TERMS.md](TERMS.md) for the terms of use.
