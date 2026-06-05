# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [0.6.2] - 2026-06-05

### Changed

- **README.md** Minor changes in the README.md.

## [0.6.1] - 2026-05-31

### Added

- **AWS commands are highlighted in the bash script approval preview.** When the agent generates a script for execution, AWS CLI invocations now stand out from the rest of the script body with inverse-color "highlighter strips" so the mutating calls are easy to spot in a long script:
  - Read-only AWS calls (`describe-*`, `list-*`, `get-*`, `s3 ls`, `sts get-caller-identity`, etc.) render as a **blue strip**.
  - Mutating AWS calls (`delete-*`, `terminate-*`, `create-*`, `put-*`, `s3 rm`, `s3 cp`, etc.) render as a **yellow strip**.
  - Everything else — shell control flow, comments, args, flags, pipelines — stays in the existing green script body color.

  Detection is pattern-based, not a full shell parser: `aws <service> <verb>` is matched wherever it appears in a line (start of line, after a pipe, after `time` or `env VAR=val`, inside a `$(...)` substitution). Read-only vs. mutating classification uses the same `READ_ONLY_VERBS` / `READ_ONLY_FULL` lists that drive the per-command auto-approve decision — single source of truth, no drift between the two features. Adding a verb to either list affects both behaviors.

  False positives (e.g. an `aws ec2 describe-instances` substring inside an `echo "..."` literal) get highlighted too. Accepted limitation: a real shell tokenizer would catch these, but the surrounding `echo` and quotes make them visually distinguishable in context.

## [0.6.0] - 2026-05-31

### Breaking

- **Config schema restructured: per-provider blocks at top level.** Provider-specific fields (`model`, `apiKey`, `apiKeyEnv`) move into a top-level block named after the provider. The old top-level `model` and `apiKeyEnv` fields are gone. For Bedrock, the `model` field also moves into the existing `bedrock` block (which already held `region` and `profile`).

  Old:
  ```json
  {
    "provider": "anthropic",
    "model": "claude-sonnet-4-6",
    "apiKeyEnv": "MY_KEY",
    "bedrock": { "region": "us-east-1" }
  }
  ```

  New:
  ```json
  {
    "provider": "anthropic",
    "anthropic": {
      "model": "claude-sonnet-4-6",
      "apiKeyEnv": "MY_KEY"
    },
    "bedrock": {
      "model": "us.anthropic.claude-sonnet-4-6",
      "region": "us-east-1"
    }
  }
  ```

  Old configs fail to load with a clear migration message pointing at the new shape — no silent fallback.

- **Strict validation of the active provider block.** When `provider` is set, the matching top-level block must exist with a `model` field. Previously the top-level `model` default kicked in if absent; now you have to be explicit. Run `aca config` to scaffold a working default.

### Added

- **`<provider>.apiKey` config field for Anthropic / OpenAI / Google.** Convenience for casual users who don't want to set env vars; persists to disk so see the security note in the README. Resolution order: `apiKeyEnv`-named env var → default provider env var → `<provider>.apiKey` from config → error. The env var always wins when both are set.
- **Default config file is created with mode `0600`** (owner read/write only) so it isn't world-readable on creation. Doesn't help if you edit the file with another tool that resets permissions.
- **Debug-level log note when the API key resolves from config** rather than an env var. Helps post-hoc forensics see what happened. The key value itself is never logged.
- **Helpful migration error for pre-0.6 configs.** Loading a config file with top-level `model` or `apiKeyEnv` produces a side-by-side old/new shape diff instead of a cryptic zod parse failure.

### Changed

- **`apiKeyEnv` moves from top-level into the per-provider block.** It was a top-level field since 0.1.0; now it lives at `<provider>.apiKeyEnv`. Same semantics, just nested.
- **`apiKeyEnv` set to an empty env var emits a warning.** Previously the fall-through to the default env var was silent — convenient until a user noticed the wrong account was being charged. Now if `<provider>.apiKeyEnv` names a variable that isn't set, `aca` prints a warning to stderr and falls back to the default env var (and then to `<provider>.apiKey`). The warning is purely informational; resolution still continues.

### Fixed

- **Ctrl-C inside an SSM session no longer prints "Cannot perform start session: read /dev/stdin: input/output error".** Previously, Ctrl-C delivered SIGINT to both the AWS CLI subprocess AND aca; aca's process tore down the shared stdin before the AWS CLI's own cleanup completed, producing the I/O-error message. The fix: `aca` installs a no-op SIGINT handler for the lifetime of any interactive AWS CLI subprocess, leaving the signal exclusively to the child. The AWS CLI now performs its normal clean shutdown and exits with code 0 or 130, which aca recognizes as a clean termination.

### Added

- **Graceful error handling for AWS CLI failures.** AWS CLI exit codes
  252–255 (parse error, missing credentials, client error, server error)
  are now classified as fatal and abort the agent loop immediately rather
  than being fed back to the model for retry. The user sees the AWS
  stderr printed verbatim in red; the process exits 1. Other non-zero
  exits remain soft failures — the model can decide whether to retry,
  bounded by `maxSteps` as before.
- **Ctrl-C handling.** Pressing Ctrl-C at any agent-driven prompt
  (approval prompts, agent-asked questions, the bash script's
  execute/save/cancel dialog) now exits cleanly with a "cancelled by
  user" message on stderr and exit code 130 (SIGINT convention). No
  stack trace, no red error, no "ran N commands" footer.
- **SSM-session Ctrl-C silenced.** When you Ctrl-C to end an interactive
  AWS CLI session (SSM Session Manager shells, port-forwards, etc.),
  exit code 130 is treated as a clean termination instead of an error.
  The audit log still records the real exit code for accuracy.
- **`endReason` field on `RunResult`.** Internal API used by cli.ts to
  pick the right exit code: `completed` (0), `cancelled` (130), or
  `fatal` (1).

### Changed

- **The "ran N commands" footer is now verbose-only.** Previously printed
  on every multi-command run; now requires `--verbose` / `-v` to surface.
  With verbose off, nothing aca generates reaches the terminal — only
  the AWS CLI's verbatim output does, matching the README's promise.

### Changed

- **Dependency upgrades.** Vercel AI SDK v4 → v6, zod v3 → v4, TypeScript
  v5 → v6, ESLint v9 → v10, `@types/node` v22 → v25, and all `@ai-sdk/*`
  provider packages to their v6-compatible majors (`@ai-sdk/anthropic`@3,
  `@ai-sdk/openai`@3, `@ai-sdk/google`@3, `@ai-sdk/amazon-bedrock`@4).
  Required code changes:
  - `generateText({ maxSteps })` → `generateText({ stopWhen: stepCountIs(n) })`
  - Tool definition field `parameters:` → `inputSchema:`
  - Tool call payload `args` → `input`
  - Usage fields `promptTokens` / `completionTokens` →
    `inputTokens` / `outputTokens` (the data we write to `usage.log` keeps
    the legacy names — they're a stable public interface, just remapped at
    extraction time).
  - `createOpenAI({ compatibility: 'strict' })` removed; the option no longer
    exists.
  - Zod v4 `.default({})` on object schemas now requires the fully-typed
    default value; updated `LoggingSchema` and `autoApprove` defaults.
  - Step events from `onStepFinish` dropped the `stepType` field; the debug
    log now only mentions `finishReason`.

### Fixed

- **Interactive AWS CLI commands now work.** Previously, commands like
  `aws ssm start-session` (interactive shells), port-forwarding sessions, and
  log tails with `--follow` appeared to hang — the child process's stdout was
  being captured into a string for the agent's context, and the child's stdin
  was never connected to the user's terminal. Now the host detects common
  interactive patterns and uses `stdio: 'inherit'` for those commands, so the
  user's terminal connects directly to the AWS CLI subprocess.
- **General log no longer echoes to the console.** Previously, the operational
  `Logger` wrote both to `general.log` *and* to stderr at every level above
  the threshold — meaning `--log-level debug` would spam debug lines into the
  user's terminal. Now `Logger` is strictly file-only; the only things that
  reach the console are (a) the AWS CLI's verbatim stdout, (b) approval
  prompts, (c) error summaries, and (d) reasoning steps when `verbose` is
  on. To watch operational logs live: `tail -f
  ~/.local/state/aws-cli-agent/general.log`.

### Added

- **`--interactive` / `-i` CLI flag** to force every AWS CLI command in a run
  to inherit the user's terminal. Useful as an escape hatch for commands not
  in the auto-detect list (`ssm start-session`, `ssm start-session` with
  port-forward documents, `ecs execute-command`, `logs tail --follow`).
- **`interactive` parameter on `execute_aws_command` tool.** Lets the agent
  explicitly mark a command as interactive when it knows the command needs
  a TTY. For interactive runs, the agent receives a "do not summarize"
  signal instead of stdout.
- **Auto-approve never applies to interactive commands.** Handing your
  terminal to a subprocess is a meaningful event; it always prompts.

- **Prompt caching** for Anthropic and Bedrock providers (`caching: true` by
  default). Marks the system prompt + tool definitions as cacheable; cache
  reads cost ~10% of normal input tokens on these providers. OpenAI
  auto-caches without our involvement; Google Gemini isn't supported yet.
  Cache hit/miss tokens are recorded in `usage.log` as `cacheReadTokens` and
  `cacheWriteTokens`. Typical cost reduction: ~60% off the input bill for
  frequent users.
- **Usage log** — `usage.log` (JSONL) records token totals per `aca`
  invocation: timestamp, provider, model, steps, prompt/completion/total
  tokens. Enable/disable via `logging.usageLog` (default `true`). Sum the
  day's tokens with `cat usage.log | jq -s 'map(.totalTokens) | add'`.
- **Interactive prompting** during the reasoning process. The `prompt_user`
  tool now supports four question kinds: `text` (free-form), `choice` (pick
  one from a finite list), `confirm` (yes/no), and `secret` (hidden input
  for short secrets like MFA codes). New `prompt_user_multi` tool batches
  several related questions into a single round so the agent doesn't need
  multiple model round-trips to gather setup data.
- **Sharpened system prompt** with explicit anti-guessing rules and worked
  examples of when to ask vs. when to discover. The agent is much more
  likely to stop and ask when it isn't certain rather than picking a
  plausible answer and acting on it.

## [0.3.0] - 2026-05-15

### Changed

- **Renamed** package from `ai-aws` to `aws-cli-agent`. Short CLI name is `aca`;
  the long name `aws-cli-agent` works too. Install with
  `npm install -g aws-cli-agent`.
- **Restructured logging config.** Replaced top-level `logLevel`, `audit.enabled`,
  and `reasoning.enabled` with a nested `logging` object:
  ```json
  "logging": { "level": "error", "auditLog": true, "reasoningLog": false }
  ```
  Defaults are now: level `error` (was `info`), audit on (unchanged), reasoning
  log **off** (was on).
- **Renamed general log file** from `ai-aws.log` to `general.log`.
- **`--verbose` is now reasoning-only.** Previously also bumped log level to
  debug; now controls only whether reasoning is echoed to the console. Use
  `--log-level debug` separately if you want a noisier general log.
- **Restructured Bedrock config** into a nested `bedrock` object:
  ```json
  "bedrock": { "region": "us-east-1", "profile": "shared-services" }
  ```
  Replaces the old top-level `bedrockRegion` / `bedrockProfile`.

### Added

- **`defaultRegion`** config and `--region` CLI flag. The configured region
  is auto-appended as `--region` to every AWS CLI call the agent makes —
  unless the agent itself specified a region, in which case its choice wins.
- **Bash script "save to disk" option.** When the agent generates a script,
  the user now sees a three-way prompt: Execute / Save to disk / Cancel.
  The save path is shown inline so you know exactly where the file lands.
  Folder is configurable via `scriptFolder`; default is
  `$XDG_DATA_HOME/aws-cli-agent/scripts`.
- **Two npm-installable binary names**: `aws-cli-agent` and `aca` (same binary).
- **GitHub Actions CI** (lint, typecheck, build, smoke test on Node 20 & 22).
- **GitHub Actions Release** workflow (publishes to npm on tag push or release
  publication, with provenance attestation).
- **Dependabot** config for npm and GitHub Actions.
- **Smoke test** script (`npm test`) that exercises the basic CLI surface
  without needing cloud credentials.

### Removed

- **`--quiet` / `-q` flag.** Use `--log-level error` (or `silent`) instead.
- **Top-level config keys** `logLevel`, `audit`, `reasoning`, `bedrockRegion`,
  `bedrockProfile`. See "Changed" above.
- **`autoApprove` no longer applies to bash scripts.** Scripts always prompt
  (Execute / Save / Cancel). The flag still skips approval for individual
  AWS CLI calls.

### Migration notes

The old `ai-aws` config at `~/.config/ai-aws/config.json` is not read or
migrated. Run `aca config` to write a fresh default at the new path. Translate
old → new keys:

| Old | New |
|---|---|
| `logLevel` | `logging.level` |
| `audit.enabled` | `logging.auditLog` |
| `reasoning.enabled` | `logging.reasoningLog` |
| `bedrockRegion` | `bedrock.region` |
| `bedrockProfile` | `bedrock.profile` |

History at the old `~/.local/state/ai-aws/` location won't be picked up.
If you want to keep it: `mv ~/.local/state/ai-aws ~/.local/state/aws-cli-agent`.

## [0.2.0] - 2026-05-14

### Added

- Amazon Bedrock as a provider option via `@ai-sdk/amazon-bedrock`. Uses the
  standard AWS credential chain; no API key required. Configurable via
  optional `bedrockRegion` and `bedrockProfile` (since superseded by nested
  `bedrock` in 0.3.0).
- Audit log: append-only JSONL of every executed command/script with full
  stdout/stderr/exit code. Bash scripts also log full source.
- Reasoning log: text record of agent reasoning steps and tool calls.
- ESLint 9 with flat config (`npm run lint`, `npm run lint:fix`).

### Changed

- Output policy: stdout is reserved for the verbatim AWS CLI output. The agent
  cannot rewrite or summarize results. Pipe to `jq`, `wc`, etc. like you would
  with the AWS CLI directly.
- Moved `history.jsonl` from `$XDG_DATA_HOME` to `$XDG_STATE_HOME` alongside
  the logs.

## [0.1.0] - 2026-05-14

### Added

- Initial release. Agentic AWS CLI assistant with multi-step tool calling
  (Vercel AI SDK), local-only state, XDG-compliant paths, configurable
  providers (Anthropic / OpenAI / Google), per-command approval prompts.
