# Changelog

All notable changes to the `gemini` plugin are documented here.

## 0.1.0

- Initial release.
- Commands: `/gemini:setup`, `/gemini:review`, `/gemini:adversarial-review`, `/gemini:status`, `/gemini:result`, `/gemini:cancel`.
- Foreground and background (detached worker) reviews against working-tree or branch diffs.
- Structured review output validated against `schemas/review-output.schema.json`.
- Optional stop-time review gate (`SessionStart`/`SessionEnd`/`Stop` hooks).
- Bundled skills: `gemini-cli-runtime`, `gemini-result-handling`, `gemini-prompting`.
