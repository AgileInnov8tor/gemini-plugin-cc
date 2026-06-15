# gemini-plugin-cc

A Claude Code plugin that lets you delegate **code reviews** to Google's
[Gemini CLI](https://github.com/google-gemini/gemini-cli) — in the foreground or as
tracked background jobs — without leaving Claude Code.

It is a structural port of [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc).
Codex's persistent app-server broker is replaced with a self-contained background-job runner that
launches one-shot `gemini -p ... -o json` workers, because the Gemini CLI is one-shot with native
sessions rather than a long-lived server.

## Requirements

- Node.js >= 18.18
- The Gemini CLI on `PATH` (`npm install -g @google/gemini-cli`), authenticated via
  `gemini` interactive login or a `GEMINI_API_KEY` environment variable.
- Git (reviews operate on the local repository diff).

## Install

```text
/plugin marketplace add <owner>/gemini-plugin-cc
/plugin install gemini@google-gemini
/reload-plugins
/gemini:setup
```

## Commands

| Command | What it does |
| --- | --- |
| `/gemini:setup` | Verify the Gemini CLI + auth; toggle the stop-time review gate. |
| `/gemini:review` | Structured code review of the local git change. |
| `/gemini:adversarial-review` | Design-challenging review; accepts focus text. |
| `/gemini:status` | List active and recent review jobs. |
| `/gemini:result` | Show the stored output for a finished job. |
| `/gemini:cancel` | Cancel an active background job. |

### Review options

```text
/gemini:review [--wait | --background] [--base <ref>] [--scope auto|working-tree|branch] [--model pro|flash] [focus ...]
```

- `--wait` runs in the foreground; `--background` queues a detached worker and returns a job id.
- `--scope auto` (default) reviews the working tree when dirty, otherwise the branch vs its base.
- `--base <ref>` reviews the diff against an explicit base ref.
- `--model pro` → `gemini-2.5-pro`, `--model flash` → `gemini-2.5-flash`; any other value is passed through.
- Reviews always run read-only (`gemini --approval-mode plan`): the plugin never edits your files.

Reviews return a structured verdict validated against
[`schemas/review-output.schema.json`](plugins/gemini/schemas/review-output.schema.json):
`verdict`, `summary`, `findings[]` (severity, file, line range, confidence, recommendation), and `next_steps[]`.

## Stop-time review gate (optional)

```text
/gemini:setup --enable-review-gate
```

When enabled, ending a session triggers a fresh Gemini review of the previous turn's code changes via
the `Stop` hook. The hook blocks the stop with `BLOCK: <reason>` if it finds an issue, or allows it with
`ALLOW: <reason>`. Disable with `/gemini:setup --disable-review-gate`.

## How it works

- `scripts/gemini-companion.mjs` builds the review diff with `git`, composes a block-structured prompt
  with an in-prompt JSON contract, runs `gemini -p <prompt> -o json --approval-mode plan`, parses the
  `{ session_id, response, stats }` envelope, then validates and renders the `response`.
- Background reviews write job state under `$CLAUDE_PLUGIN_DATA/state/<workspace>/` (falling back to
  `/tmp/gemini-companion/`) and run in a detached `task-worker` process. `status`, `result`, and `cancel`
  operate on those records; `cancel` terminates the worker's process tree.
- Three hooks manage session state: `SessionStart`/`SessionEnd` track and clean up jobs, and `Stop` runs
  the optional review gate.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Not affiliated with or endorsed by Google.
