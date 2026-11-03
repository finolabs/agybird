# Migrating to the shared FINOLABS catalog

Before this change, Agybird's own repository served two catalogs: the Claude Code marketplace `agybird` and the Codex marketplace `Finolabs`. Both are gone. FINOLABS plugins are listed in one catalog, [`finolabs/plugins`](https://github.com/finolabs/plugins), which Claude Code and Codex both register as `finolabs` (lowercase).

| Before | Now |
| --- | --- |
| Claude Code `agybird@agybird` | `agybird@finolabs` |
| Codex `agybird@Finolabs`, or `agybird@agybird` from before 0.3.0 | `agybird@finolabs` |
| Codex `vietnamizer@Finolabs`, `markmap-skills@Finolabs` | `vietnamizer@finolabs`, `markmap-skills@finolabs` |

Antigravity is unchanged: it installs from the repository URL, now `https://github.com/finolabs/agybird`.

## Why a plain upgrade fails

- The old catalogs no longer exist in this repository, so `claude plugin marketplace update agybird` and `codex plugin marketplace upgrade Finolabs` have nothing to fetch.
- On macOS, Codex keeps one plugin cache folder per catalog name without regard to case. `Finolabs` and `finolabs` share a folder, so the same plugin installed from both overwrites itself. Remove the old one first.

## Migrate

Run each step only if the old entry is present (`claude plugin list`, `codex plugin list`, `codex plugin marketplace list`). Back up what you are about to change and leave unrelated plugins, MCP servers and configuration alone.

Claude Code:

```bash
claude plugin uninstall agybird@agybird
claude plugin marketplace remove agybird
claude plugin marketplace add finolabs/plugins
claude plugin install agybird@finolabs
```

Codex:

```bash
codex plugin remove agybird@Finolabs          # and every other @Finolabs plugin you installed
codex plugin marketplace remove Finolabs
codex plugin marketplace add finolabs/plugins
codex plugin add agybird@finolabs             # reinstall what you removed
```

Start a new session and confirm that the skill loads once, not twice. Check the command names against `claude plugin --help` and `codex plugin --help` for your version.

## Roll back

Pin the last release that served its own catalog:

```bash
codex plugin marketplace add finolabs/agybird --ref v0.3.2
```

Then reinstall the old selectors you want and remove the `finolabs` entries. Never overwrite `~/.codex/` in bulk; that discards newer, unrelated configuration changes.
