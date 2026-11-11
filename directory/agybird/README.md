# Agybird

Agybird lets Claude Code hand work to the official Google Antigravity CLI (`agy`) that you already have installed and signed in to, using your own Antigravity sign-in and Gemini plan. It is unofficial and not affiliated with Google.

It works in Claude Code only: every command starts `agy` on your computer, which claude.ai chat and Cowork cannot do.

## What it does

- `/agybird:review` and `/agybird:adversarial-review` have Antigravity review your uncommitted changes, or your branch against a base, read-only, and print findings by severity, file and line.
- `/agybird:rescue` hands a coding, debugging or investigation task to Antigravity, read-only unless you ask for changes, through the `agybird-rescue` subagent.
- `/agybird:status`, `/agybird:result` and `/agybird:cancel` manage jobs started with `--background`.
- `/agybird:usage` shows your Antigravity quota per pool and the model each tier would use now; `/agybird:setup` checks that `agy` is installed and signed in.
- An optional review gate, off until you run `/agybird:setup --enable-review-gate` in a repository, has Antigravity review each turn's uncommitted changes before Claude finishes, and sends Claude back once when it finds a medium or worse issue.

Nothing runs unless you call a command, ask for Agybird, `agy` or Antigravity by name, or switch the gate on.

## Requirements

Node.js 20 or newer, and the [official Antigravity CLI](https://antigravity.google/docs/cli/install), installed and signed in by running `agy` once. Google keeps enforcing your plan, quota, permissions, sandbox and content policy; Agybird bypasses none of them.

## What it runs, sends and stores

- **Runs:** `node` on the plugin's own scripts, `git` in your repository to collect a diff (with fsmonitor, textconv, external diff and filter programs switched off), and `agy`, always as argument lists without a shell. It never passes `--dangerously-skip-permissions` and never grants a permission for you: a denied action is shown to you, and only your approval of that exact request is applied.
- **Sends:** only to Google, through `agy`, under your account: the task you delegate, the diff under review, files Antigravity reads in your workspace while it works, and, for the review gate, Claude's last message of the turn. Agybird has no server, analytics or telemetry.
- **Stores, on your computer only:** the Antigravity conversation id per workspace in `~/.agybird/sessions/`; each job's prompt, result and log, the gate switch and a five-minute quota cache in the plugin's data folder, readable only by you; and grants you approve, written to Antigravity's own project settings and removed after one run unless you chose to remember them.

See the [privacy policy](https://github.com/finolabs/agybird/blob/main/PRIVACY.md), [terms](https://github.com/finolabs/agybird/blob/main/TERMS.md) and [threat model](https://github.com/finolabs/agybird/blob/main/docs/threat-model.md).

## Source

This folder is generated from the [Agybird repository](https://github.com/finolabs/agybird) by `scripts/build-directory-edition.mjs`, which removes the image features of the full plugin. Report issues at https://github.com/finolabs/agybird/issues.

## License

[MIT](LICENSE).
