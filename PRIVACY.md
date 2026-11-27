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

- The transport you choose in setup, in `config.json` in the job store (globally, or per repository with `--here`).
- For each desktop permission request answered from Agybird, a file `<job>.answered-<n>` in the job store, holding only the answer given (`1` or `Skip`), created before the answer is pressed and removed only when the app refused it before any press, so the approval cannot be used twice.
- `~/.agybird/desktop.lock`: while a desktop run is going, the process id of that run and when its lock expires; from Send on, also that the app may be running its task and the app's title of its conversation. When the run could not stop the app, the file stays after the run until a later run sees that conversation idle in the app, or you remove it.

With the desktop transport the task goes to Google through the Antigravity desktop app instead of `agy`, under the same account and terms. The runner reads the text of the conversation it started (to tell when the turn ended, and the permission prompt it shows) and copies the reply, which it stores in the job store as the CLI path stores results. It puts the task on the clipboard to paste it, from the write until the pasted text has been read back (about a second, several seconds for a long review), and then restores what the clipboard held before. That write is kept on this Mac (not sent to other devices through Universal Clipboard) and marked transient and concealed, so clipboard managers that follow the nspasteboard.org convention neither show nor keep it; any app reading the clipboard during that window can still read the task. The reply is put on the clipboard by the app's own Copy button, without those marks, for the moment it takes to read it back, so a clipboard manager or Universal Clipboard may pick up the reply. Only plain text is restored, with the transient or concealed marks it carried: a copied image, file or rich text on the clipboard is lost, and the run warns when that happens. It reads the name of the app in front so it can bring it back.

The review gate, when you switch it on for a repository, sends that repository's uncommitted diff and Claude's last message of the turn to Google through `agy` each time a turn ends with changes.

The runner reads prompts from standard input, never from a credential store, keychain, or browser session, and never prints `agy`'s raw stderr into the result envelope.

## Reporting issues

Public issues and pull requests are visible to everyone. Remove credentials, personal data, and private repository content from any envelope, log, or prompt before you post it. Report security problems privately as described in [SECURITY.md](SECURITY.md).
