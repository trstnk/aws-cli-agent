# aws-cli-agent (`aca`)

> Agentic AI assistant that turns natural-language requests into AWS CLI commands and runs them locally.

You describe what you want in plain English. The agent searches your local history, lists your AWS profiles, runs read-only discovery calls to resolve resources, prompts you for anything ambiguous, and executes the final command — after asking for permission.

```
$ aca "start ssm session to instance test-instance in abc-xyz"
  Reason:  resolve instance id for test-instance
  Command: aws ec2 describe-instances --filters Name=tag:Name,Values=test-instance \
           --output json --profile abc-xyz
  ✓ auto-approved (read-only)

  Reason:  start interactive SSM session
  Command: aws ssm start-session --target i-0123abc --profile abc-xyz
? Execute this command? (Y/n)
```

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

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-5-20250929",
  "maxSteps": 15,
  "logging": {
    "level": "error",
    "auditLog": true,
    "reasoningLog": false
  },
  "verbose": false,
  "autoApprove": {
    "readOnly": true,
    "all": false
  },
  "historyLimit": 200
}
```

Optional fields (omit if you don't need them):

```json
{
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
| `maxSteps` | `15` | Hard cap on agent reasoning/tool steps per request |
| `logging` | see below | All logging knobs (see below) |
| `verbose` | `false` | Echo agent reasoning to the console as it runs |
| `autoApprove.readOnly` | `true` | Skip prompt for read-only AWS CLI commands (`describe-*` / `list-*` / `get-*` / `s3 ls`) |
| `autoApprove.all` | `false` | Skip prompt for **all AWS CLI commands** including mutating ones. Does NOT apply to bash scripts — those always prompt. |
| `historyLimit` | `200` | Max history entries kept in memory for context |
| `scriptFolder` | `$XDG_DATA_HOME/aws-cli-agent/scripts` | Where saved bash scripts are written |

### Logging

```json
"logging": {
  "level": "error",
  "auditLog": true,
  "reasoningLog": false
}
```

| Key | Default | Meaning |
|---|---|---|
| `logging.level` | `error` | General-log verbosity: `silent` \| `error` \| `warn` \| `info` \| `debug` \| `trace`. Override per run with `--log-level`. |
| `logging.auditLog` | `true` | Write `audit.log` — JSONL trail of every executed command/script with full stdout/stderr/exit code. Bash scripts also log full source. |
| `logging.reasoningLog` | `false` | Write `reasoning.log` — text record of agent reasoning steps and tool calls. |
| `logging.usageLog` | `true` | Write `usage.log` — one JSONL entry per `aca` invocation with token totals (input + completion + total). One line per run. |

Three logs, three files, three switches. `verbose` is independent of `reasoningLog`: you can write reasoning to the file without echoing to the console, or vice versa.

### Verbosity

`verbose` (config) or `-v` / `--verbose` (CLI) controls **one thing**: whether agent reasoning is echoed to the console as it runs. It does not affect the general log level. To get a noisier general log, use `--log-level debug` (or set `logging.level` in config).

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

`aca` sends the same system prompt and tool definitions on every step of every invocation — roughly 5 KB of stable content. When `caching: true` (the default), this prefix is marked cacheable on providers that support it:

| Provider | Caching behavior |
|---|---|
| **Anthropic (direct)** | Cached via `cache_control: ephemeral`. Reads cost ~10% of normal input tokens. Writes cost ~125%. TTL ~5 minutes. |
| **Bedrock (Anthropic models)** | Cached via Bedrock's `cachePoint` API. Same economics as Anthropic-direct. Other Bedrock models (Nova, Llama) may or may not support caching depending on the underlying model. |
| **OpenAI** | Auto-caches any prompt over 1,024 tokens; the `caching` flag is ignored (and unnecessary). |
| **Google Gemini** | Caching API isn't wired up in this version. The `caching` flag is silently ignored. |

The token counts written to `usage.log` include cache hit/miss accounting where available:

```json
{
  "promptTokens": 4821,
  "completionTokens": 142,
  "totalTokens": 4963,
  "cacheReadTokens": 4500,
  "cacheWriteTokens": 0
}
```

A typical multi-step run after the cache is warm: the first step writes the cache (~5 KB), subsequent steps within the same run read it (4,500 read tokens each). The next `aca` invocation within ~5 minutes also reads from the cache. Cost reduction in practice: roughly 60% off the input bill for users who invoke `aca` frequently.

Disable with `caching: false` if you run `aca` rarely (once an hour or less), since first-call cache writes cost slightly more than uncached prompts.

### Bash scripts: execute or save

When the agent generates a bash script (e.g. for org-wide queries), `aca` shows the full script and offers a three-way choice:

```
What would you like to do with this script?
❯ Execute now
  Save to disk (/home/me/.local/share/aws-cli-agent/scripts/2026-05-14_19-12-44_list-aurora.sh)
  Cancel
```

- **Execute** — write to temp, run, audit, delete (unchanged from earlier behavior).
- **Save** — write to `scriptFolder` (default `$XDG_DATA_HOME/aws-cli-agent/scripts`) with mode 0700. The full path is shown both in the prompt and in stdout after the run.
- **Cancel** — nothing executed, nothing saved.

The prompt is **always** shown for scripts, even when `autoApprove.all` is on. Scripts are arbitrary code with shell-level capability — the auto-approve switch deliberately doesn't apply to them. `autoApprove` still affects individual AWS CLI commands as documented above.

## CLI options

```
aca [options] [request...]

Options:
  -v, --verbose            echo agent reasoning to the console as it runs
  --log-level <level>      override logging.level for this run
  --auto-approve           auto-approve all commands and scripts (dangerous)
  --profile <name>         hint the agent to use this AWS profile
  --region <name>          override defaultRegion for this run

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

- **Agent loop**: Vercel AI SDK `generateText` with multi-step tool calling, hard-capped by `maxSteps`. Every step is funneled through `onStepFinish`.
- **Stateless remote**: each call sends the full conversation; no provider-side state is kept.
- **Local-only state**: history, logs, config — all under XDG paths.
- **Tools as the safety boundary**: tools are the only way the agent can affect the world; mutating tools prompt the user by default.
- **stdout is reserved for AWS CLI output** — pipe `aca ... | jq` exactly like you'd pipe `aws ... | jq`. All chrome (reasoning, prompts, status) goes to stderr.

## License

MIT
