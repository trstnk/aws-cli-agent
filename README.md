# aws-cli-agent (`aca`)

> Agentic AI assistant that turns natural-language requests into AWS CLI commands and runs them locally.

You describe what you want in plain English. The agent searches your local history, lists your AWS profiles, runs read-only discovery calls to resolve resources, prompts you for anything ambiguous, and executes the final command — after asking for permission.

## Examples

```bash
# Interactive session to an instance the agent has to look up
aca "start ssm session to instance my-instance in my-account"

# Use the AWS CLI's table output for human consumption
aca "print tags of gitlab instance as table"

# Cross-resource composition: instances, their IAM roles, and the attached policies
aca "list ec2 instance id, name, instance profile arn plus the iam policies in the attached iam role as json in my-account"
```

The first example is interactive — the agent runs a read-only `describe-instances` to resolve the name, then prompts before opening the SSM session. The second produces a table on stdout, pipeable to `less` or `grep`. The third is the kind of request where the agent will most likely build a bash script with `jq` plumbing rather than chain individual AWS CLI calls.

## ⚠️ Warning — read before using

`aca` runs real AWS CLI commands against your real AWS accounts. Treat it accordingly.

- **The agent executes AWS CLI commands on your behalf.** Commands run with whatever credentials and roles your local `aws` CLI is configured to use. Anything you can do interactively, `aca` can do. Anything an attacker who got your credentials could do, a hallucinating model could do too.
- **Models hallucinate.** The agent is instructed not to guess and to ask for missing information, but model behavior is statistical, not contractual. A misinterpreted request can produce an unintended command. Always read the `Reason:` / `Command:` block before pressing `y`.
- **Auto-approve is dangerous.** `autoApprove.readOnly: true` (the default) skips the prompt only for non-mutating commands (`describe-*`, `list-*`, `get-*`, `s3 ls`). `autoApprove.all: true` skips the prompt for **every** command — a misrouted `delete-*` or `terminate-*` can ruin your weekend or your career. Set it only in tightly scoped one-off workflows, never as a persistent default.
- **Bash scripts are arbitrary code.** When the agent generates a bash script for multi-account or composition workflows, the script can do anything your shell can. Read it before you press execute. The "save to disk" option exists so you can review it in your editor first; use it when in doubt.
- **Watch the bill.** Every invocation sends a prompt to your LLM provider and pays for tokens. Token totals per run are logged in `usage.log` (`cat ~/.local/state/aws-cli-agent/usage.log | jq -s 'map(.totalTokens) | add'`). Caching is on by default and cuts ~25-40% off input costs for frequent users; if you invoke `aca` rarely (once an hour or less) the cache writes don't pay back and you can set `caching: false`.
- **Your prompts go to the model provider.** AWS CLI output is fed back to the model as part of subsequent steps. That means resource names, instance IDs, tag values, and any other data that appears in command output is transmitted to Anthropic / OpenAI / Google / Bedrock (depending on your provider choice). The provider does not retain this data beyond the request itself (and the cache TTL, ~5 minutes for cached prefixes), but **confirm this is compatible with the policies you have to respect** before pointing `aca` at sensitive accounts.
- **Provider terms apply.** When you use a provider, you agree to that provider's terms of service. For Bedrock, that's AWS's own terms (data stays in your AWS account boundary). For Anthropic / OpenAI / Google, that's their respective enterprise / API terms. Read them.
- **Audit log is your friend.** Every executed command — including its stdout, stderr, and exit code — lands in `audit.log` (JSONL). If you ever need to reconstruct what happened, it's all there. Don't disable `logging.auditLog` unless you have a specific reason.
- **No warranty.** **You use this agent at your own risk.** The authors are not responsible for unintended AWS API calls, deleted resources, exceeded budgets, or any other damage caused by using this tool. If you wouldn't run `aws` commands blindly from a script you found in someone's gist, don't run `aca` blindly either.

## Trademark & affiliation

`aws-cli-agent` (`aca`) is an independent project, not affiliated with or
endorsed by Amazon Web Services. "AWS" and "Amazon Web Services" are
trademarks of Amazon.com, Inc.

## Installation

```bash
npm install -g aws-cli-agent
```

Two binaries are installed: `aws-cli-agent` (full name) and `aca` (short alias). They're identical.

Requirements:
- Node.js ≥ 20
- AWS CLI v2 on `$PATH`
- An API key for one supported provider (Anthropic / OpenAI / Google),
  **or** AWS credentials with Bedrock model access if you choose the Bedrock provider

## Setup

```bash
# 1. Create the config file with sane defaults
aca config

# 2. Set the API key for your chosen provider (env var only — never in config)
export ANTHROPIC_API_KEY=sk-ant-...
# or OPENAI_API_KEY=...
# or GOOGLE_GENERATIVE_AI_API_KEY=...
# (Bedrock needs no API key — uses your AWS credential chain)

# 3. Try it
aca "list all s3 buckets in account my-staging"
```

## Configuration

Config file: `$XDG_CONFIG_HOME/aws-cli-agent/config.json` (defaults to `~/.config/aws-cli-agent/config.json`).

Default contents (created by `aca config`):

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5-20250929",
  "maxSteps": 15,
  "logging": {
    "level": "error",
    "auditLog": true,
    "reasoningLog": false,
    "usageLog": true
  },
  "caching": true,
  "verbose": false,
  "autoApprove": {
    "readOnly": true,
    "all": false
  },
  "forceInteractive": false,
  "historyLimit": 200
}
```

Optional fields (omit if you don't need them):

```json
{
  "apiKeyEnv": "MY_CUSTOM_ANTHROPIC_KEY",
  "defaultRegion": "eu-west-1",
  "scriptFolder": "/home/me/aws-scripts",
  "bedrock": {
    "region": "us-east-1",
    "profile": "shared-services"
  }
}
```

### Top-level keys

| Key | Default | Meaning |
|---|---|---|
| `provider` | `anthropic` | LLM provider: `anthropic` \| `openai` \| `google` \| `bedrock` |
| `model` | `claude-sonnet-4-5-20250929` | Model identifier (Bedrock uses fully-qualified IDs — see below) |
| `apiKeyEnv` | — | Override the env var name that holds the API key (ignored for `bedrock`) |
| `bedrock` | — | Bedrock-specific settings (see below). Only used when `provider = "bedrock"`. |
| `defaultRegion` | — | AWS region injected into every AWS CLI command when the agent didn't specify one |
| `caching` | `true` | Enable prompt caching for providers that support it. See "Prompt caching" below. |
| `maxSteps` | `15` | Hard cap on agent reasoning/tool steps per request (range 1-50) |
| `logging` | see below | All logging knobs |
| `verbose` | `false` | Echo agent reasoning to the console as it runs |
| `autoApprove.readOnly` | `true` | Skip prompt for read-only AWS CLI commands (`describe-*` / `list-*` / `get-*` / `s3 ls`) |
| `autoApprove.all` | `false` | Skip prompt for **all AWS CLI commands** including mutating ones. Does NOT apply to bash scripts — those always prompt. |
| `forceInteractive` | `false` | Run every AWS CLI command with inherited stdio. Persistent equivalent of `--interactive`/`-i`. Almost always leave unset and use the CLI flag for one-offs. |
| `historyLimit` | `200` | Max history entries kept in memory for context |
| `scriptFolder` | `$XDG_DATA_HOME/aws-cli-agent/scripts` | Where saved bash scripts are written |

### Logging

```json
"logging": {
  "level": "error",
  "auditLog": true,
  "reasoningLog": false,
  "usageLog": true
}
```

| Key | Default | Meaning |
|---|---|---|
| `logging.level` | `error` | General-log verbosity: `silent` \| `error` \| `warn` \| `info` \| `debug` \| `trace`. Override per run with `--log-level`. |
| `logging.auditLog` | `true` | Write `audit.log` — JSONL trail of every executed command/script with full stdout/stderr/exit code. Bash scripts also log full source. |
| `logging.reasoningLog` | `false` | Write `reasoning.log` — text record of agent reasoning steps and tool calls. |
| `logging.usageLog` | `true` | Write `usage.log` — one JSONL entry per `aca` invocation with token totals (input + completion + total + cache hit/miss). |

Logs are file-only. None of these settings affect what's printed to the console — that's a separate concern handled by `verbose` (reasoning lines) and the CLI's normal output (the AWS CLI's stdout passthrough plus approval prompts). To watch operational logs live in a separate terminal: `tail -f ~/.local/state/aws-cli-agent/general.log`.

### `defaultRegion` and `--region`

If `defaultRegion` is set, `aca` appends `--region <value>` to every AWS CLI command the agent runs — **only when the agent didn't already specify a region itself**. The agent's choice (driven by the user's prompt or history) always wins. Override per run with `--region`.

```bash
aca --region eu-west-1 "list ec2 instances in my-staging"
```

### Bedrock

When `provider = "bedrock"`, configure region and (optionally) profile via the nested `bedrock` object:

```json
{
  "provider": "bedrock",
  "model": "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  "bedrock": {
    "region": "us-east-1",
    "profile": "shared-services"
  }
}
```

- **Model IDs**: Bedrock uses fully-qualified inference-profile IDs. The `us.` / `eu.` / `apac.` prefix is required for most newer Anthropic models. Use `aws bedrock list-inference-profiles --region <region>` to discover what your account can invoke.
- **`bedrock.profile`** is independent from operational profiles. The agent calls Bedrock under `bedrock.profile`, but each AWS CLI command it issues uses its own `--profile` (resolved from the user's prompt / history). This is the right pattern when one account holds Bedrock entitlements and other accounts hold workloads.
- If `bedrock.region` is unset, falls back to `AWS_REGION` / `AWS_DEFAULT_REGION` env vars.

### Prompt caching

`aca` sends the same system prompt on every step of every invocation — roughly 3,300 tokens of stable content. When `caching: true` (the default), this prefix is marked cacheable on providers that support it:

| Provider | Caching behavior |
|---|---|
| **Anthropic (direct)** | Cached via `cache_control: ephemeral`. Reads cost ~10% of normal input tokens. Writes cost ~125%. TTL ~5 minutes. |
| **Bedrock (Anthropic models)** | Cached via Bedrock's `cachePoint` API. Same economics as Anthropic-direct. Other Bedrock models (Nova, Llama) may or may not support caching depending on the underlying model. |
| **OpenAI** | Auto-caches any prompt over 1,024 tokens; the `caching` flag is ignored (and unnecessary). |
| **Google Gemini** | Caching API isn't wired up in this version. The `caching` flag is silently ignored. |

The token counts written to `usage.log` include cache hit/miss accounting where available:

```json
{
  "promptTokens": 7914,
  "completionTokens": 188,
  "totalTokens": 8102,
  "cacheReadTokens": 3305,
  "cacheWriteTokens": 0
}
```

Only the system prompt is cached. Tool definitions are part of the request body the provider re-tokenizes on every call — the AI SDK doesn't propagate tool-level cache markers in the Bedrock provider, so we can't extend the cache prefix that far in this version. The realistic cost reduction is therefore around 25-40% of the input token bill on warm-cache runs (the system prompt is ~3,300 of the ~7,000-9,000 input tokens a typical run sends).

Disable with `caching: false` if you run `aca` rarely (once an hour or less), since first-call cache writes cost slightly more than uncached prompts.

### Bash scripts: execute or save

When the agent generates a bash script (e.g. for org-wide queries), `aca` shows the full script and offers a three-way choice:

```
What would you like to do with this script?
❯ Execute now
  Save to disk (/home/me/.local/share/aws-cli-agent/scripts/2026-05-14_19-12-44_list-aurora.sh)
  Cancel
```

- **Execute** — write to temp, run, audit, delete.
- **Save** — write to `scriptFolder` (default `$XDG_DATA_HOME/aws-cli-agent/scripts`) with mode 0700. The full path is shown both in the prompt and in stdout after the run.
- **Cancel** — nothing executed, nothing saved.

The prompt is **always** shown for scripts, even when `autoApprove.all` is on. Scripts are arbitrary code with shell-level capability — the auto-approve switch deliberately doesn't apply to them. `autoApprove` still affects individual AWS CLI commands as documented above.

## CLI options

```
aca [options] [request...]

Options:
  -v, --verbose            echo agent reasoning to the console as it runs
  --log-level <level>      override logging.level for this run:
                           silent | error | warn | info | debug | trace
  --auto-approve           auto-approve all commands and scripts (dangerous)
  --profile <name>         hint the agent to use this AWS profile
  --region <name>          override defaultRegion for this run
  -i, --interactive        force AWS CLI commands to inherit your terminal
                           (for shells, port-forwards, log tails — common
                           patterns auto-detect; this is the manual override)

Commands:
  run <request...>         (default) execute a natural-language request
  config                   print path to config file (creates defaults if missing)
  history [-n <count>]     print recent history entries
  paths                    print paths used by aws-cli-agent
```

## Interactive prompting

The agent can ask you questions mid-reasoning when it's missing information.
You'll see prompts like:

```
? Agent needs input:
? Which profile? (Use arrow keys)
❯ prod-us-east-1
  staging-us-east-1
  dev-eu-west-1
```

Four question kinds are supported:

- **choice** — pick one from a finite list (used for profiles, buckets,
  matched resources). Arrow keys + Enter.
- **text** — free-form input, optionally with a default value.
- **confirm** — yes/no decision before risky actions.
- **secret** — hidden input for short secrets like MFA codes. Long-lived AWS
  credentials never come through here; those come from your AWS profile.

For requests that need multiple values up front (e.g. source profile +
target profile + region for a cross-account copy), the agent asks them in
sequence as one batched conversation rather than across multiple model
calls.

The agent is instructed to **ask rather than guess** whenever a required
value is unclear. If you find it guessing wrong on your particular workflow,
make the request more specific or check `~/.local/state/aws-cli-agent/reasoning.log`
to see where it inferred the value from.

## Where state lives (XDG)

Two directories under XDG. State (logs, history) is co-located in one place; user-curated data (saved scripts) lives separately:

| Purpose | Path |
|---|---|
| Config | `$XDG_CONFIG_HOME/aws-cli-agent/config.json` |
| State (history, all logs) | `$XDG_STATE_HOME/aws-cli-agent/` |
| Saved scripts (default) | `$XDG_DATA_HOME/aws-cli-agent/scripts/` |

State directory contents:
```
~/.local/state/aws-cli-agent/
├── history.jsonl       # past requests, for context
├── general.log         # general operational log
├── audit.log           # JSONL audit trail of every executed command
├── reasoning.log       # text log of agent reasoning per step
└── usage.log           # JSONL token totals per invocation
```

Run `aca paths` to see the actual resolved locations on your system.

## Architecture

```
   your machine
   ┌────────────────────────────────────────────────────────┐
   │                                                        │
   │   you type a request in the terminal                   │
   │                       │                                │
   │                       ▼                                │
   │            ┌──────────────────────┐                    │
   │            │  agent loop          │                    │
   │            │  (Vercel AI SDK,     │                    │
   │            │   streamText)        │                    │
   │            └──────────┬───────────┘                    │
   │                       │                                │
   │           selects a tool to call:                      │
   │             - query_history                            │
   │             - list_aws_profiles                        │
   │             - prompt_user / prompt_user_multi          │
   │             - execute_aws_command                      │
   │             - execute_bash_script                      │
   │                       │                                │
   │                       ▼                                │
   │            ┌──────────────────────┐                    │
   │            │  approval gate       │                    │
   │            │  (skipped if         │                    │
   │            │   auto-approved or   │                    │
   │            │   read-only tool)    │                    │
   │            └──────────┬───────────┘                    │
   │                       │ y                              │
   │                       ▼                                │
   │            ┌──────────────────────┐                    │
   │            │  aws CLI subprocess  │ ◀── credentials    │
   │            │                      │     from ~/.aws    │
   │            └──────────┬───────────┘     (profiles,     │
   │                       │                  SSO cache)    │
   │                       ▼                                │
   │            stdout printed verbatim to terminal         │
   │                                                        │
   │                                                        │
   │   state on disk (XDG paths):                           │
   │     config.json    history.jsonl                       │
   │     general.log    audit.log                           │
   │     reasoning.log  usage.log                           │
   │     saved scripts/                                     │
   │                                                        │
   └─────────────────────┬──────────────────────────────────┘
                         │
              messages + tool definitions (HTTPS)
                         │
                         ▼
   ┌────────────────────────────────────────────────────────┐
   │  LLM provider                                          │
   │    Anthropic · OpenAI · Google · Bedrock               │
   │    prompt cache (~5 min TTL) — system prompt only      │
   └────────────────────────────────────────────────────────┘
```

**The agent loop.** `aca` uses the Vercel AI SDK's `streamText` to run a multi-step reasoning loop, hard-capped by `maxSteps`. Each step: the model emits reasoning text (streamed live to the console when `verbose` is on), decides on a tool call, the host runs the tool (with approval if needed), and the result feeds back into the next step's prompt. The loop terminates when the model emits a final text response with no tool call, or when `maxSteps` is reached.

**Stateless server-side, with one caveat.** Each call to the LLM provider includes the full conversation history — system prompt, tool definitions, original user request, every prior step's reasoning and tool results. The provider doesn't retain conversation state between calls. **One exception:** when prompt caching is enabled, the provider temporarily stores the cached prefix (the system prompt, ~3,300 tokens) for ~5 minutes so subsequent calls within that window can replay it cheaply. Nothing else is retained.

**Local-only state.** Everything `aca` remembers is on your machine. History (`history.jsonl`), logs (`general.log`, `audit.log`, `reasoning.log`, `usage.log`), and config all live under XDG paths. Saved scripts go to `$XDG_DATA_HOME/aws-cli-agent/scripts/` by default. No remote backend, no telemetry.

**Tools as the safety boundary.** The model can only affect the outside world through tools. Two of them — `execute_aws_command` and `execute_bash_script` — are the destructive paths. Both prompt for user approval by default; read-only AWS CLI commands may auto-approve depending on `autoApprove.readOnly`; bash scripts **always** prompt regardless of auto-approve settings.

**stdout vs. stderr discipline.** `aca` reserves stdout exclusively for the AWS CLI's verbatim output. Everything `aca` itself emits — approval prompts, reasoning lines, agent narrative, error summaries, status footers — goes to stderr. The discipline means you can pipe `aca` like the underlying `aws` command:

```bash
aca "list buckets in my-staging" | jq -r '.[].Name'  # works
aca "list ec2 instances" > instances.json            # works
aca ... 2>/dev/null                                  # silence the agent's chrome
```

Without this rule, the approval prompts and reasoning lines would land in the next process's stdin and corrupt downstream tools. With it, the agent is invisible to pipelines — exactly as if you'd run the `aws` command directly.

## License

MIT
