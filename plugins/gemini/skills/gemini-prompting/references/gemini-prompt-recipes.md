# Gemini Prompt Recipes

Starting templates for Gemini prompts. Copy the smallest recipe that fits, then trim.
All recipes assume read-only Gemini (`--approval-mode plan`): inspect and reason, do not edit.

## Code Review (structured)

```xml
<task>
Review the provided repository context for correctness, safety, and material quality issues.
</task>

<structured_output_contract>
Return only a single JSON object matching the review schema:
{ "verdict": "approve"|"needs-attention", "summary": string,
  "findings": [ { "severity": "critical"|"high"|"medium"|"low", "title": string, "body": string,
    "file": string, "line_start": integer, "line_end": integer, "confidence": number, "recommendation": string } ],
  "next_steps": [ string ] }
</structured_output_contract>

<grounding_rules>
Ground every finding in the provided context. Label inferences and keep confidence honest.
</grounding_rules>
```

## Adversarial Review

```xml
<role>
You are Gemini performing an adversarial software review. Break confidence in the change.
</role>

<task>
Find the strongest reasons this change should not ship yet. Target the expensive, hard-to-detect failures.
</task>

<dig_deeper_nudge>
Check second-order failures, empty-state behavior, retries, stale state, and rollback paths.
</dig_deeper_nudge>

<structured_output_contract>
Return only the review JSON object. Use `needs-attention` for any material risk.
</structured_output_contract>
```

## Diagnosis

```xml
<task>
Diagnose why the failing test or command is breaking in this repository.
</task>

<compact_output_contract>
Return: 1) most likely root cause 2) evidence 3) smallest safe next step.
</compact_output_contract>

<missing_context_gating>
Do not guess missing repository facts. State exactly what remains unknown.
</missing_context_gating>

<verification_loop>
Before finalizing, verify the proposed root cause matches the observed evidence.
</verification_loop>
```

## Stop-Gate Verdict

```xml
<task>
Review only the previous turn's code changes. Decide whether they should ship.
</task>

<compact_output_contract>
First line must be exactly ALLOW: <reason> or BLOCK: <reason>. Nothing before it.
</compact_output_contract>

<grounding_rules>
Verify code actually changed from repository state before you block. Do not trust the response text alone.
</grounding_rules>
```
