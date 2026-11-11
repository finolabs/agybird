# Antigravity CLI Documentation Index

Use this curated map to navigate official live documentation for deep or specialized topics.

## Core Reference Tree

- **Overview & Architecture**: `https://antigravity.google/docs/cli/overview`
  - Integration with Antigravity 2.0, shared agent harness, settings synchronization.
- **Headless & Streaming IPC**: `https://antigravity.google/docs/cli/headless`
  - Single-shot `-p`, NDJSON stream events (`init`, `step_update`, `result`), `--json-schema`, token counters (`thinking_tokens`, `cache_read_tokens`), stdin multi-turn streaming.
- **Fine-Grained Permissions**: `https://antigravity.google/docs/cli/permissions`
  - Action schema `action(target)`, precedence (`deny` > `ask` > `allow`), token prefix matching, path normalization.
- **Background Tasks & Subagents**: `https://antigravity.google/docs/cli/subagents`
  - Custom markdown agents (`.agents/agents/<name>.md`), subagent lifecycle states, teleports (`Alt+J`), fast-path approvals (`Ctrl+K`).
- **Sandbox & Containment**: `https://antigravity.google/docs/cli/sandbox`
  - OS-level isolation (`sandbox-exec` on macOS, `nsjail` on Linux, `AppContainer` on Windows), `--sandbox` flag.
- **Artifacts & Reviews**: `https://antigravity.google/docs/cli/artifacts`
  - Lifecycle of plans, code diffs, Mermaid diagrams (ASCII / Kitty graphics), media assets in `brain/<conversation_id>/`.
- **AI Credits & Quotas**: `https://antigravity.google/docs/cli/credits`
  - G1 credit consumption, statusline alerts, `useG1Credits` policy.
- **Plugins, Skills & Hooks**: `https://antigravity.google/docs/cli/plugins`
  - Plugin bundle layout (`plugin.json`, `hooks.json`, `mcp_config.json`), local/global skills, MCP tool definitions.
- **Settings & Keybindings**: `https://antigravity.google/docs/cli/settings`
  - Sparse JSON persistence in `settings.json`, alt-screen vs inline rendering modes, `keybindings.json` custom maps.
- **Conversation Management**: `https://antigravity.google/docs/cli/conversations`
  - Directory-scoped session cache, session resumption (`--continue`, `--conversation`), branching with `/fork`.
- **Best Practices**: `https://antigravity.google/docs/cli/best-practices`
  - Verification loops, 3-phase execution (Exploration -> Planning -> Execution), prompt context enrichment.
- **CLI Reference & Slash Commands**: `https://antigravity.google/docs/cli/reference`
  - Complete index of flags, settings parameters, default keybindings, and slash commands (`/agents`, `/permissions`, `/diff`, `/resume`, `/tasks`, etc.).

## Commands Deep-Dives

- **Permissions Overlay**: `https://antigravity.google/docs/cli/commands/permissions`
- **Session Resume**: `https://antigravity.google/docs/cli/commands/resume`
- **Agent Manager**: `https://antigravity.google/docs/cli/commands/agents`
- **Diff Viewer**: `https://antigravity.google/docs/cli/commands/diff`
- **Quota & Usage**: `https://antigravity.google/docs/cli/commands/usage`
- **Status Line**: `https://antigravity.google/docs/cli/commands/statusline`
