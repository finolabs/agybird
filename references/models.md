# Model selection and quota

Pick the lowest model tier that can finish the task, check that its quota pool still has room, and fall back to an equivalent model in another pool when it does not. Image work is the exception: the `image-generator` subagent picks its own model, so do not pass `--model` to choose one.

## Check quota

Run `agy -p /usage` from the workspace before the first run of a new objective and again after any run that ends in `error`. The CLI answers this slash command itself, so it starts no model turn. Run it as its own command, never inside a stream-json session. Each line is tab-separated: pool, limit, remaining percentage, reset time in UTC. Output observed with `agy` 1.4.7:

```text
Gemini Models	Weekly Limit Remaining	98%	2026-11-01T15:15:36Z
Gemini Models	Five Hour Limit Remaining	98%	2026-10-26T07:46:17Z
Claude and GPT models	Weekly Limit Remaining	19%	2026-10-26T05:00:02Z
Claude and GPT models	Five Hour Limit Remaining	100%	2026-10-26T09:00:48Z
Gemini 4 Argon	Gemini 4 Argon Weekly Limit	100%	2026-11-01T15:13:41Z
```

Quota belongs to pools, not to single models. `gemini-*` models draw on "Gemini Models"; `claude-*` and `gpt-*` models draw on "Claude and GPT models"; some models, such as Gemini 4 Argon, also have a limit of their own. These pool assignments are read from the labels above, not from documentation. A model is usable only when every limit that covers it, five-hour and weekly alike, is above 0%. Treat a pool under roughly 10% as nearly empty for a long or heavy task, and prefer an equivalent pool with more room. Report reset times in the user's local time zone.

## Choose a tier

List current slugs with `agy models`. A slug already carries its reasoning level (`-low`, `-medium`, `-high`), so pick the slug and leave out `--effort` unless the user asks for a level the slug does not express. The tiers below are a starting heuristic from the `agy` 1.4.7 list, not a benchmark. Map new slugs to the nearest tier.

| Tier | Use for | Gemini pool | Claude and GPT pool |
| --- | --- | --- | --- |
| Light | Lookups, summaries, structured extraction, small single-file edits | `gemini-3.8-flash-low`, `gemini-3.8-flash-medium` | `claude-sonnet-5-5-low`, `gpt-oss-120b-medium` |
| Standard | Most debugging, multi-file changes, tests, analysis over local context | `gemini-3.8-flash-high`, `gemini-4-argon-low`, `gemini-4-argon-medium`, `gemini-4-hydrogen-low`, `gemini-4-hydrogen-medium` | `claude-sonnet-5-5-medium` |
| Heavy | Architecture, subtle or cross-cutting bugs, long refactors, a lower tier that already failed | `gemini-4-argon-high`, `gemini-4-hydrogen-high`, `gemini-4-hydrogen-xhigh` | `claude-sonnet-5-5-high`, `claude-opus-5-5-medium`, `claude-opus-5-5-high` |

`gemini-4-hydrogen-*` slugs appear in `agy models` from `agy` 1.5.8. They are placed by reasoning level only, not benchmarked, and only `-low` has been run through Agybird. `agy -p /usage` shows no limit of their own for them, so they draw on "Gemini Models" like other `gemini-*` slugs. `gemini-pro-orchestrator-g1-pro` ("Orchestrator (Argon)") is not tiered; do not choose it unless the user asks. `gemini-4-carbon-*` appears only with `GEMINI_API_KEY` or Application Default Credentials sign-in and has not been checked.

Start at Light or Standard. Move up a tier only when the task clearly needs it or a lower tier produced a weak result; say why. Pass the chosen slug with `--model` on the first run of the objective and keep it for follow-ups unless a fallback is needed. When the user asks to keep the current model, pass no `--model`.

## Fall back when quota runs out

The docs describe no automatic model fallback, and the error for an exhausted quota is not documented. After an `error` (including exit code 3), run `agy -p /usage` and check whether any limit covering the chosen model is at 0%: its shared pool's five-hour and weekly limits, and any limit of its own, such as Gemini 4 Argon's weekly limit.

1. If the model was your choice, switch to a model of the same tier in a pool that still has quota, rerun, and tell the user which model you switched to and why. Prefer the same conversation; passing a different `--model` on a resumed conversation has not been verified live, so check the result rather than assuming it worked.
2. If no pool has quota at the same tier, do not silently move up a tier, because that spends more. Report the reset times and ask whether to wait, take a lower tier, or take a higher one.
3. If the user named the model, do not switch on your own. Report its reset time and offer the equivalent model.
4. Never turn on `useG1Credits` or any other credit overage to get past a quota; ask the user first. See [troubleshooting.md](troubleshooting.md).
