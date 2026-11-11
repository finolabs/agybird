# General work

Use `--category general` for tasks that are not repository engineering: summarization, local research, comparison, planning, structured extraction, and requested non-code deliverables.

Default to `--mode read`. Use `--mode write` only when the requested outcome is a file or another explicit workspace change.

## Structured output with schemas

For structured output, enforce format constraints using `--json-schema`:
- **JSON Schema object**: An inline schema string, e.g. `'{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}'`
- **File path**: Path to a `.json` schema definition file.

The schema root must be `"type": "object"`. Since `agy` 1.2.14 plain text, a bare type name such as `string`, a missing file, or a non-object root fails at startup with exit code 1. Wrap a single value in an object property instead.

The parsed payload will appear directly in `structured_output` within the result envelope. Keep the task bounded to the absolute working directory and name any required source files.

## Session continuity & verification

For a follow-up that genuinely depends on Antigravity's prior context, reuse the returned `conversation_id` with `--conversation` (or rely on the workspace default session). Start a fresh conversation with `--new-session` when the tasks are independent to avoid stale context.

Verify factual claims against local source material or primary external sources appropriate to the task. Verify created deliverables by opening or parsing them with a tool independent of `agy`.

See the official [headless-mode guide](https://antigravity.google/docs/cli/headless) for structured output and conversation controls.
