# Code work

## Choose the mode

- Use `--category code --mode read` for review, diagnosis, architecture analysis, explanation, or planning that does not require edits.
- Use `--category code --mode write` only when the user asks to implement, fix, refactor, add tests, or otherwise change files.

## Prompting best practices

- **Partition complex changes into phases**:
  1. *Exploration*: Instruct `agy` to inspect the target codebase and explain interface definitions without modifying files.
  2. *Planning*: Request an explicit implementation plan outlining targeted files and logic changes.
  3. *Execution*: Direct `agy` to apply edits once the plan is approved.
- **Narrow the scope**: Provide absolute file paths or specific symbol names in the prompt to focus reasoning and minimize token overhead.
- **Establish verification loops**: When asking `agy` to implement code, explicitly instruct it to execute existing test commands (e.g., `npm test`, `pytest`) to verify its changes before finishing.
- **Preserve repository style**: State the exact requested scope. Preserve the repository's own conventions, formatting, and unrelated user changes.

## Verify independently

For read mode, capture the repository state before and after and confirm there are no new changes caused by the delegation.

For write mode:

1. Inspect `git status --short`, `git diff`, and untracked files after `agy` finishes.
2. Confirm each changed line is in the user's requested scope.
3. Rerun the smallest relevant test, build, lint, or reproduction outside `agy`.
4. Report Antigravity's result separately from your independent verification.

Do not accept a textual claim that tests passed as evidence. Use the real command output. If the workspace is not a Git repository, snapshot the bounded target files or use another non-destructive comparison.

See the official [best-practices guide](https://antigravity.google/docs/cli/best-practices) for workspace context and non-interactive usage.
