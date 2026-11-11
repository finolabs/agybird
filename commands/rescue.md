---
description: Hand a coding, debugging or investigation task to Antigravity through Agybird
argument-hint: '[--write] [--fresh] [--background] [--model <slug>] <what Antigravity should do>'
disable-model-invocation: true
allowed-tools: Agent, AskUserQuestion
---

Start the `agybird:agybird-rescue` subagent with the Agent tool (`subagent_type: "agybird:agybird-rescue"`) and give it the user's request below unchanged, flags included. It is a subagent, not a skill: do not call it with the Skill tool.

The user's request: $ARGUMENTS

Show the subagent's result as it returns it, without summarizing. If the result says Antigravity needs a permission, ask the user with AskUserQuestion: allow once, allow and remember, or decline, naming the tool, the target and the suggested rule exactly as shown. Only on an allow, start the subagent again with the same task, the line "The user approved this exact rule: <rule>, scope once|remember", and the instruction to retry the denied action.
