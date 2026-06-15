---
name: gemini-prompting
description: Internal guidance for composing Gemini 2.5 prompts for code review, diagnosis, and research inside the Gemini Claude Code plugin
user-invocable: false
disable-model-invocation: true
---

# Gemini Prompting

Use this skill when composing or revising the prompts that the Gemini plugin sends to the Gemini CLI
(`gemini -p ... -o json`), or when adapting a request into a tighter Gemini prompt.

Prompt Gemini like an operator, not a collaborator. Keep prompts compact and block-structured with
XML tags. State the task, the output contract, the follow-through defaults, and the small set of
extra constraints that matter. Gemini runs read-only here (`--approval-mode plan`), so prompts must
rely on inspection and reasoning, not edits.

Core rules:
- Prefer one clear task per Gemini run. Split unrelated asks into separate runs.
- Tell Gemini what done looks like. Do not assume it will infer the desired end state.
- Add explicit grounding and verification rules for any task where unsupported guesses would hurt quality.
- Prefer better prompt contracts over longer natural-language explanations.
- Use XML tags consistently so the prompt has stable internal structure.

Output contracts for `-o json`:
- The Gemini CLI envelope is `{ session_id, response, stats }`. The model's answer is the `response` string.
- For structured output, instruct Gemini in-prompt to return ONLY a single JSON object and spell out
  the exact shape (Gemini has no native output-schema flag). Then parse `response` as JSON.
- Keep the JSON contract tied to `schemas/review-output.schema.json`: `verdict`, `summary`, `findings[]`
  (`severity`, `title`, `body`, `file`, `line_start`, `line_end`, `confidence`, `recommendation`), `next_steps[]`.
- For the stop-gate, require a compact first line of `ALLOW: <reason>` or `BLOCK: <reason>` instead of JSON.

Default prompt recipe:
- `<role>` / `<task>`: the concrete job and the relevant repository or failure context.
- `<structured_output_contract>` or `<compact_output_contract>`: exact shape, ordering, and brevity.
- `<grounding_rules>`: required for review, research, or anything that could drift into unsupported claims.
- `<dig_deeper_nudge>` or `<verification_loop>`: for adversarial review and correctness-sensitive work.

When to add blocks:
- Review or adversarial review: add `grounding_rules`, `structured_output_contract`, and `dig_deeper_nudge`.
- Diagnosis: add `compact_output_contract`, `verification_loop`, and `missing_context_gating`.
- Research or recommendation: add `research_mode` and `citation_rules`.

Working rules:
- Prefer explicit prompt contracts over vague nudges.
- Use stable XML tag names that match the block names in the reference file.
- Do not raise the model tier first. Tighten the prompt and verification rules before escalating to `--model pro`.
- Keep claims anchored to observed evidence. If something is a hypothesis, say so.

Reusable blocks live in [references/prompt-blocks.md](references/prompt-blocks.md).
Concrete end-to-end templates live in [references/gemini-prompt-recipes.md](references/gemini-prompt-recipes.md).
