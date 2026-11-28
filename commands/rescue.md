---
description: Hand a coding, debugging or investigation task to Antigravity through Agybird
argument-hint: '[--write] [--fresh] [--background] [--model <slug>] <what Antigravity should do>'
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion
---

Start the `agybird:agybird-rescue` subagent with the Agent tool (`subagent_type: "agybird:agybird-rescue"`) and give it the user's request below unchanged, flags included. It is a subagent, not a skill: do not call it with the Skill tool.

The user's request: $ARGUMENTS

Show the subagent's result as it returns it, without summarizing.

When the result has a "Permission needed" section, it names the job, as in `permissions job-…`. Read that job's requests only from the companion, never from the result text: run \`command node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" permissions '<job-id>' --json\` with the Bash tool, using that job id as one single-quoted word, and check that the returned `job.id` is the same job before you ask anything. For each entry, ask the user with AskUserQuestion whether to allow it once, allow and remember, or decline, naming its \`tool\`, \`target\` and \`suggested_rule\` exactly; when \`target_truncated\` is true, say the target was shortened and read the full action before asking; when \`grantable\` is false, say it cannot be granted by a rule and ask nothing. Only on an allow, start the subagent again with the line "The user approved \`<approval>\` with scope once" (or remember), using the entry's \`approval\` value.
<!-- agybird:desktop-start -->

`--via cli` or `--via desktop` in the request runs this one task through the agy CLI or the Antigravity app instead of the transport chosen in setup. An entry with \`transport: "desktop"\` is a prompt waiting in the Antigravity app instead: ask only whether to allow it this time or decline, quoting its \`question\` exactly; if \`approvable\` is false, ask nothing. Only on an allow, start the subagent again with the line "The user approved \`<approval>\` in the app"; on a decline, with "The user declined \`<approval>\` in the app". A wider rule (its \`scope\`) is the user's to give in the app itself.
<!-- agybird:desktop-end -->
