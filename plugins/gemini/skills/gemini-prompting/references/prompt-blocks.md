# Prompt Blocks

Use these blocks selectively when composing Gemini prompts.
Wrap each block in the XML tag shown in its heading.

## Core Wrapper

### `role`

Use to set the operating identity for review-style prompts.

```xml
<role>
You are Gemini performing a focused software code review.
</role>
```

### `task`

Use in nearly every prompt.

```xml
<task>
Describe the concrete job, the relevant repository or failure context, and the expected end state.
</task>
```

## Output and Format

### `structured_output_contract`

Use when the response shape matters. Gemini has no native output-schema flag, so spell out the shape.

```xml
<structured_output_contract>
Return only a single valid JSON object and nothing else. No prose, no markdown, no code fences.
The object must match this shape exactly: { ... }.
Put the highest-value findings first.
</structured_output_contract>
```

### `compact_output_contract`

Use when you want a concise first line or short prose instead of a schema.

```xml
<compact_output_contract>
Return a compact final answer.
Your first line must be exactly one of: ALLOW: <reason> or BLOCK: <reason>.
</compact_output_contract>
```

## Grounding and Verification

### `grounding_rules`

Use for review, research, or root-cause analysis.

```xml
<grounding_rules>
Ground every claim in the provided context or your read-only tool outputs.
Do not present inferences as facts. If a point is a hypothesis, label it clearly.
</grounding_rules>
```

### `missing_context_gating`

Use when Gemini might otherwise guess.

```xml
<missing_context_gating>
Do not guess missing repository facts.
If required context is absent, inspect it with read-only tools or state exactly what remains unknown.
</missing_context_gating>
```

### `verification_loop`

Use when correctness matters.

```xml
<verification_loop>
Before finalizing, verify the result against the task requirements and the inspected files.
If a check fails, revise the answer instead of reporting the first draft.
</verification_loop>
```

### `citation_rules`

Use when external research or quotes matter.

```xml
<citation_rules>
Back important claims with explicit references to the source material you inspected.
Prefer primary sources.
</citation_rules>
```

## Task-Specific Blocks

### `dig_deeper_nudge`

Use for review and adversarial inspection.

```xml
<dig_deeper_nudge>
After you find the first plausible issue, check for second-order failures, empty-state behavior,
retries, stale state, and rollback paths before you finalize.
</dig_deeper_nudge>
```

### `research_mode`

Use for exploration, comparisons, or recommendations.

```xml
<research_mode>
Separate observed facts, reasoned inferences, and open questions.
Prefer breadth first, then go deeper only where the evidence changes the recommendation.
</research_mode>
```
