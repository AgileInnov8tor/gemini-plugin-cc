---
name: gemini-cli-runtime
description: Internal helper contract for invoking the gemini-companion runtime from the Gemini plugin's review commands
user-invocable: false
disable-model-invocation: true
---

# Gemini Runtime

This skill documents the exact contract for calling the gemini-companion helper that backs the
`/gemini:*` commands. It is internal reference only.

Primary helper:
- `node "${CLAUDE_PLUGIN_ROOT}/scripts/gemini-companion.mjs" <verb> "<raw arguments>"`

Verbs:
- `review` — structured code review of the local git change.
- `adversarial-review` — design-challenging review of the local git change; accepts focus text.
- `setup` — check the Gemini CLI + auth and toggle the stop-time review gate.
- `status` / `result` / `cancel` — inspect and manage tracked review jobs.

Execution rules:
- The commands are forwarders. Run exactly one companion invocation per command and return its stdout unchanged.
- Prefer the helper over hand-rolled `git`, direct `gemini` CLI strings, or other Bash activity.
- The companion always runs Gemini read-only (`--approval-mode plan`). It never edits files.
- Preserve the user's arguments as-is apart from stripping execution-control routing flags.

Flag mapping:
- `--model pro` maps to `gemini-2.5-pro`; `--model flash` maps to `gemini-2.5-flash`; any other `--model` value is passed through.
- `--base <ref>` and `--scope auto|working-tree|branch` choose the review target.
- `--background` queues a detached worker and returns a job id; `--wait` runs in the foreground.
- There is no reasoning-effort flag. Do not invent `--effort`; the Gemini CLI does not support it.
- `--json` returns the raw machine payload instead of rendered markdown.

Safety rules:
- This runtime is review-only. Do not use it to apply fixes.
- Do not strip `--background`/`--wait` from the raw argument string yourself; the command layer decides how to detach.
- If the Bash call fails or Gemini cannot be invoked, return the error and stop. Do not substitute your own review.
