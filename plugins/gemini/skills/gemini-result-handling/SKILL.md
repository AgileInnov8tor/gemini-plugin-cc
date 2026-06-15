---
name: gemini-result-handling
description: Internal guidance for presenting Gemini review helper output back to the user
user-invocable: false
disable-model-invocation: true
---

# Gemini Result Handling

When the helper returns Gemini review output:
- Preserve the helper's verdict, summary, findings, and next-steps structure.
- Present findings first and keep them ordered by severity.
- Use the file paths and line numbers exactly as the helper reports them.
- Preserve evidence boundaries. If Gemini marked something as an inference, uncertainty, or follow-up question, keep that distinction.
- If there are no findings, say that explicitly and keep the residual-risk note brief.
- CRITICAL: After presenting review findings, STOP. Do not make any code changes. Do not fix any issues. You MUST explicitly ask the user which issues, if any, they want fixed before touching a single file. Auto-applying fixes from a review is strictly forbidden, even if the fix is obvious.
- If the helper reports malformed output or a failed Gemini run, include the most actionable stderr lines and stop there instead of guessing.
- If Gemini was never successfully invoked, do not generate a substitute review at all. Report the failure and stop.
- If the helper reports that setup or authentication is required, direct the user to `/gemini:setup` and do not improvise alternate auth flows.
