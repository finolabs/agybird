# Privacy

Agybird is an Agent Skill and a small local Node.js runner. It has no server, no analytics, and no telemetry, and its maintainers receive nothing from your runs.

## Where your data goes

Agybird exists to hand work to the official Google Antigravity CLI (`agy`). Everything you delegate leaves your machine through `agy`, under your own Google account:

- the task prompt that Claude Code or Codex writes for `agy`;
- files, diffs, and reference images in the workspace that `agy` reads while it works;
- anything `agy` fetches or generates on your behalf.

Google processes that data under its own terms and privacy policy, not this repository's. See [Google's Antigravity terms](https://antigravity.google/terms) and the [Google Privacy Policy](https://policies.google.com/privacy). The host agent that runs the skill, Claude Code or Codex, processes the conversation under its provider's policy as well.

Agybird triggers only when you ask for Agybird, `agy`, or Antigravity CLI by name, so nothing is delegated to Google unless you request it. Do not delegate work over files you are not allowed to share with Google.

## What Agybird stores on your machine

- `~/.agybird/sessions/`: one file per workspace with the workspace path and the Antigravity conversation id, so a follow-up resumes the same conversation. It never records prompts or results. Deleting a file only makes the next run start a new conversation.
- `~/.agybird/grant-locks/<workspace>/`: the grant lock, one small numbered file per grant you approve holding the run's process id and conversation id; a finished grant's file is marked released and kept, and only the latest twenty or so are kept.
- `~/.agybird/active-runs/<workspace>/`: one small file per running run with its process ids and conversation id, so a grant never reaches another conversation; it is removed when the run ends, and a file left by a killed run is discarded once its processes are gone.
- A grant you approve with `--grant` is written to Antigravity's own project configuration and, with the default `once` scope, removed again when the run ends.
- The job store of the commands (`/agybird:*` in Claude Code, `$agybird-*` in Codex): in the plugin's data folder, or `~/.agybird/jobs/` when the host gives none, one folder per repository holding each job's prompt, result, rendered output and log, readable only by you. A review's prompt contains the diff it covered. The store also keeps the review gate switch and a five-minute cache of the `agy -p /usage` and `agy models` output. Nothing is uploaded from it; delete a folder to forget its jobs. Uninstalling the Claude Code plugin removes the plugin data folder.

The review gate, when you switch it on for a repository, sends that repository's uncommitted diff and Claude's last message of the turn to Google through `agy` each time a turn ends with changes.

The runner reads prompts from standard input, never from a credential store, keychain, or browser session, and never prints `agy`'s raw stderr into the result envelope.

## Reporting issues

Public issues and pull requests are visible to everyone. Remove credentials, personal data, and private repository content from any envelope, log, or prompt before you post it. Report security problems privately as described in [SECURITY.md](SECURITY.md).
