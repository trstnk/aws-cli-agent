# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/).

## [Unreleased]

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
