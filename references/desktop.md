# Desktop transport

Read this when the user chose the desktop transport (`/agybird:setup` or `$agybird-setup` reports `Transport: desktop`) or passes `--via desktop`. The CLI stays the default; nothing here applies to it.

## What it is

The runner `scripts/desktop.mjs` takes the same arguments, the same prompt on standard input and returns the same envelope as `scripts/agybird.mjs`, but the task runs in a new conversation of the Antigravity desktop app on macOS. It drives the app through the macOS Accessibility API: it sends no keystrokes, presses only the app's own controls and menu items, and touches no other app except to bring the user's front app back afterwards. The envelope carries `evidence.transport: "desktop"`, `evidence.app_version`, `evidence.preset` and `evidence.changed_files`.

```bash
command node "/absolute/path/to/agybird/scripts/desktop.mjs" \
  --category code \
  --cwd "/absolute/workspace" \
  --mode read <<'AGYBIRD_PROMPT_7F3A'
Explain how the parser handles empty input.
AGYBIRD_PROMPT_7F3A
```

Every run starts a new conversation; there is no resume. The runner keeps the title the app gives that conversation and reads, copies and presses only while the app shows it; if you open another conversation in the app during a run, the run ends `error` without touching it. The runner refuses `--category image`, `--swarm`, `--grant`, `--model`, `--effort`, `--agent`, `--sandbox` and `--conversation`, naming the flag: the app uses the model and settings chosen in it. Image work, usage and the review gate always use the CLI. `--json-schema` asks for one fenced JSON block at the end of the reply; the runner checks its top-level `required` keys and returns it as `structured_output`.

## Before a run

Grant Accessibility to the app that runs Agybird (the terminal, Claude, Codex or ZCode) in System Settings > Privacy & Security > Accessibility, then start a new session: a grant reaches only processes started after it. The workspace folder must already be a project in the app; the runner finds it in the project list the app shares with the CLI and opens a new conversation in it.

While the prompt is pasted (about a second), the app comes to the front and the clipboard holds the prompt; both are put back right after, and the clipboard again while the reply is copied. Ask the user not to type into the app during that moment. If the pasted text reads back differently, the runner clears the input and sends nothing.

`blocked` names its reason in `evidence.blocked_reason`: `not_macos`, `app_missing` (open the app), `not_trusted` (grant Accessibility, new session), `unsupported_version` (outside the tested 2.35.x; the user may confirm with `AGYBIRD_DESKTOP_ALLOW_VERSION=1`), `labels_missing` (another app version or language), `no_project` (open the folder as a project in the app), `ambiguous_project` (two projects share the name; rename one), `locked` (another desktop run is in progress).

## Permissions

The app's permissions preset is the user's own setting: the runner accepts `Request Review`, `Default`, `Auto` and `Turbo` and never changes it. Under `Auto` and `Turbo` the app may run commands and edit files without asking, and the envelope warns so. Read mode then only detects changes after the fact: any change to the working tree, or a moved `HEAD`, makes the run `error`, and `changed_files` names the files.

When the app asks for a permission, the run ends `needs_permission` with the app still waiting. Each request carries the app's `question`, the rule `scope` its wider options name, and the `options` shown. Put the question in front of the user. Approving answers "Yes, allow this time" once: `companion.mjs task --approve <job-id>:<n>` with no other flag. In the same read that presses it, the runner checks that the app shows the conversation that asked, the same question and that exact option, and refuses otherwise. If the run had already changed the working tree in read mode, the runner declines the prompt and the run ends `error` instead. Agybird never presses the options that allow a command for the whole conversation or always; when the user wants that, they answer in the app themselves. A run that reaches its deadline is stopped in the app.
