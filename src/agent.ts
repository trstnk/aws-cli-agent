import { generateText, stepCountIs } from 'ai';
import type { Logger } from './logger.js';
import type { Config } from './config.js';
import type { History, HistoryEntry } from './history.js';
import type { AuditLogger } from './audit.js';
import type { ReasoningLogger } from './reasoning.js';
import type { UsageLogger } from './usage.js';
import { createModel } from './providers.js';
import { createTools } from './tools/index.js';

const SYSTEM_PROMPT = `You are aws-cli-agent (aca), an agentic assistant that translates natural-language requests into AWS CLI commands and executes them locally on the user's machine.

Capabilities (via tools):
- query_history: search local past commands to recover context (profiles, bucket/instance/cluster names).
- list_aws_profiles: enumerate ~/.aws profiles to map account names to profiles.
- execute_aws_command: run an AWS CLI call. Read-only calls (describe-/list-/get-/s3 ls) may auto-approve; mutating calls always prompt the user.
- prompt_user: ask the user ONE question (kind: text | choice | confirm | secret) to fill in missing information mid-reasoning.
- prompt_user_multi: ask several related questions in one round (e.g. "source profile + destination profile + region").
- execute_bash_script: run a bash script. Use for multi-account / loop / jq workflows.

CARDINAL RULE — DO NOT GUESS. If you don't know a value that's required for the user's task, ASK the user via prompt_user (or prompt_user_multi). This is non-negotiable. Concrete examples:

- The user said "list buckets" but didn't say which account, and history has no obvious match → call list_aws_profiles, then prompt_user with kind="choice" listing the profiles.
- A "describe-instances" call returned 3 instances with the requested tag → prompt_user with kind="choice" listing the 3 candidates. Do NOT pick one yourself.
- The user said "delete the old logs bucket" but several buckets contain "logs" → prompt_user with kind="choice" showing the matches.
- You're about to run a destructive command (delete-, terminate-, remove-, drop-, etc.) and have any doubt about the right target → prompt_user with kind="confirm" stating exactly what will be deleted.
- The user asked for an MFA-protected action and you need the code → prompt_user with kind="secret".

When you DON'T need to ask:
- The value is unambiguous in the user's request ("in account abc-xyz" → profile is abc-xyz).
- query_history returned a single clean match for the relevant token.
- The value is determinable by a read-only AWS CLI call (e.g. instance id by tag, when there's exactly one match).

Asking earns trust. Guessing wrong and acting on it is much worse than one extra question.

Operating rules:
1. ALWAYS start by calling query_history with the most informative tokens from the user request. Use the results to infer profile and common parameters.
2. If the user names an account that history did not resolve, call list_aws_profiles. If still ambiguous, prompt_user with kind="choice" listing the available profiles.
3. For multi-step requests (e.g. "ssm session to instance NAME in ACCOUNT"), first run a read-only describe/list call to resolve the resource (instance id, cluster endpoint, etc.). If exactly one match, proceed. If multiple, prompt_user with choices. If zero, prompt_user kind="text" asking for a more specific name (and offer to retry).
4. When you need multiple unrelated parameters up front (e.g. source profile, target profile, region), call prompt_user_multi once instead of three separate prompt_user calls. When the answer to A would determine what to ask for B, use separate prompt_user calls in sequence.
5. For tasks that span multiple AWS accounts or require composition (jq, loops), build a bash script with "set -euo pipefail" at the top and invoke execute_bash_script.
6. Default to the user's preferred output format. For listings the user will read directly (e.g. "list buckets", "list instances"), use the AWS CLI's default text/table output, NOT JSON. Only use "--output json" when you specifically need to parse fields for a subsequent step.
7. Region handling: if the user names a region in the request, pass it explicitly with --region. If they don't, omit --region entirely — the host CLI will inject the user's configured defaultRegion automatically when one is set. Never invent a region.
8. Interactive commands: some AWS CLI commands require a real terminal — SSM Session Manager shells (\`ssm start-session\`), port-forwarding sessions (the same command with --document-name AWS-StartPortForwardingSession*), ECS Exec (\`ecs execute-command\`), log tails with --follow. For these, set \`interactive: true\` on the execute_aws_command call. The host will connect the user's terminal directly to the command and you will receive no stdout — DO NOT try to summarize or describe the output afterwards, since you can't see it. Common patterns auto-detect, but setting the flag explicitly is safer.
9. The final action of a successful run MUST be either execute_aws_command (the user-requested action) or execute_bash_script. If the user cancels via prompt_user, stop gracefully and explain in one sentence.
10. NEVER include credentials, API keys, secrets, or session tokens in commands or scripts. AWS credentials come from the user's existing profile.
11. Keep your reasoning concise — one or two sentences per step. DO NOT summarize, restate, reformat, or describe the output of the AWS CLI. The CLI's stdout is shown to the user directly by the host program. Your only post-execution job is to stop. If anything went wrong, say so briefly; if it succeeded, you may stop without further commentary.`;

export type RunResult = {
  /** Model's free-form text. Useful only for the "no command ran" error path. */
  text: string;
  steps: number;
  commands: string[];
  profile: string | null;
  /** The verbatim stdout of the last successful execute_* call, or null. */
  finalOutput: string | null;
  /** The verbatim stderr of the last execute_* call if it failed, or null. */
  finalError: string | null;
  /** Did any execute_* call run successfully? */
  ranCommand: boolean;
};

export async function runAgent(opts: {
  input: string;
  config: Config;
  logger: Logger;
  history: History;
  audit: AuditLogger;
  reasoning: ReasoningLogger;
  usage: UsageLogger;
}): Promise<RunResult> {
  const { input, config, logger, history, audit, reasoning, usage } = opts;

  const executions: import('./tools/index.js').ExecutionRecord[] = [];

  const record = (entry: import('./tools/index.js').ExecutionRecord) => {
    executions.push(entry);
  };

  const tools = createTools({ logger, config, history, audit, record });
  const model = createModel(config);

  logger.info(`Starting agent (provider=${config.provider}, model=${config.model})`);
  logger.debug('User input', input);
  reasoning.beginRun(input);

  // Inline a small recent-history hint so the model has soft context even
  // before it explicitly calls query_history. Statelessness on the server
  // side is preserved: we send the full prompt each call.
  const recent = history.recent(5);
  const historyHint = recent.length
    ? '\n\nRecent past requests (most recent first):\n' +
      recent
        .map(
          (e, i) =>
            `${i + 1}. "${e.input}" -> profile=${e.profile ?? 'n/a'}` +
            (Object.keys(e.resources).length ? ` resources=${JSON.stringify(e.resources)}` : ''),
        )
        .join('\n')
    : '';

  // Whether to enable prompt caching for this run. Caching is provider-
  // specific: Anthropic + Bedrock support an explicit `cacheControl` /
  // `cachePoint` marker per content block. OpenAI auto-caches prompts
  // over 1024 tokens with no opt-in needed (and ignores any marker we
  // send). Google's caching API is structurally different and the SDK
  // doesn't currently expose it in a way we can wire up uniformly, so we
  // skip it. The flag itself is honored regardless: if you set
  // caching=false, we don't send markers anywhere.
  const useCaching =
    config.caching && (config.provider === 'anthropic' || config.provider === 'bedrock');

  // The cached prefix is the SYSTEM PROMPT only — kept byte-stable across
  // invocations. The per-invocation history hint goes in the user message
  // where it can't invalidate the cache. Tool definitions are part of the
  // request prefix the providers cache implicitly when the system message
  // is marked, so we don't need a separate marker for those.
  const systemMessageProviderOptions = useCaching
    ? {
        anthropic: { cacheControl: { type: 'ephemeral' as const } },
        bedrock: { cachePoint: { type: 'default' as const } },
      }
    : undefined;

  // Build the user-side content. Prepend the history hint so it stays
  // OUTSIDE the cached system message (it varies per invocation and would
  // bust the cache if included in the system prompt).
  const userContent = historyHint
    ? `${historyHint}\n\n---\n\nUser request: ${input}`
    : input;

  const result = await generateText({
    model,
    messages: [
      {
        role: 'system',
        content: SYSTEM_PROMPT,
        providerOptions: systemMessageProviderOptions,
      },
      { role: 'user', content: userContent },
    ],
    // The SDK warns when role:'system' messages appear in the messages array
    // because that field is a potential prompt-injection vector for callers
    // who template the system message from user input. In our case the
    // system message is a hardcoded string literal (SYSTEM_PROMPT) and we
    // need it in the messages array — not the top-level `system:` param —
    // so we can attach providerOptions for prompt caching. Setting this
    // flag is the SDK's documented way of saying "I'm aware, my system
    // message is trusted."
    allowSystemInMessages: true,
    tools,
    // AI SDK v5+ replaced the `maxSteps: number` setting with `stopWhen`,
    // which accepts one or more stop conditions. stepCountIs(n) is the
    // straight equivalent.
    stopWhen: stepCountIs(config.maxSteps),
    onStepFinish: (step) => {
      // General logger gets a terse step marker; reasoning logger gets the
      // semantic content (text + tool calls). Tool results are too large to
      // log here — they're already in the audit log for execute_* tools.
      logger.debug(`Step finished (finishReason=${step.finishReason})`);
      reasoning.logStep({
        reasoning: step.text ?? '',
        toolCalls: (step.toolCalls ?? []).map((c) => ({
          toolName: c.toolName,
          // v6: tool call payload field renamed args -> input. Dynamic
          // (untyped) tool calls don't carry `input` on the same shape, so
          // we read it defensively.
          args: 'input' in c ? c.input : undefined,
        })),
        finishReason: step.finishReason,
      });
    },
  });

  logger.info(`Agent finished after ${result.steps.length} step(s)`);
  logger.debug('Final text', result.text);

  // Extract cache hit/miss token counts from provider-specific metadata.
  // Anthropic exposes them on result.providerMetadata.anthropic.* (camelCase),
  // Bedrock on result.providerMetadata.bedrock.* with slightly different
  // names. Other providers won't have these fields; missing → 0.
  //
  // Note: providerMetadata on the *result* aggregates the last step's values,
  // not totals across steps. For caching analysis the first-step values
  // (write tokens) and later-step values (read tokens) both matter. The AI
  // SDK doesn't aggregate them; if you want per-step accuracy, parse
  // reasoning.log. The single-line totals here are the headline numbers.
  const pm = (result.providerMetadata ?? {}) as Record<string, Record<string, unknown>>;
  const cacheReadTokens =
    toNumber(pm.anthropic?.cacheReadInputTokens) ||
    toNumber(pm.bedrock?.cacheReadInputTokens) ||
    0;
  const cacheWriteTokens =
    toNumber(pm.anthropic?.cacheCreationInputTokens) ||
    toNumber(pm.bedrock?.cacheWriteInputTokens) ||
    0;

  // Token usage for this invocation. result.usage carries totals across all
  // steps. AI SDK v5 renamed promptTokens → inputTokens and completionTokens
  // → outputTokens (totalTokens kept its name). Numeric fallback to 0 guards
  // against rare provider responses that omit a field.
  usage.log({
    input,
    provider: config.provider,
    model: config.model,
    steps: result.steps.length,
    promptTokens: result.usage?.inputTokens ?? 0,
    completionTokens: result.usage?.outputTokens ?? 0,
    totalTokens: result.usage?.totalTokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
  });
  logger.debug('Usage', { ...result.usage, cacheReadTokens, cacheWriteTokens });

  // Find the last successful execution — its stdout IS the answer to the user.
  // (Intermediate discovery calls are scaffolding; we don't print them.)
  const lastOk = [...executions].reverse().find((e) => e.ok) ?? null;
  const lastAny = executions.length > 0 ? executions[executions.length - 1] : null;
  const lastProfile =
    [...executions].reverse().find((e) => e.profile)?.profile ?? null;

  const finalOutput = lastOk?.stdout ?? null;
  const finalError = lastOk ? null : (lastAny?.stderr ?? null);
  const ranCommand = lastOk !== null;

  const entry: HistoryEntry = {
    timestamp: new Date().toISOString(),
    input,
    commands: executions.map((e) => e.cmd),
    profile: lastProfile,
    resources: {},
    success: ranCommand,
  };
  history.append(entry);

  return {
    text: result.text,
    steps: result.steps.length,
    commands: executions.map((e) => e.cmd),
    profile: lastProfile,
    finalOutput,
    finalError,
    ranCommand,
  };
}

/**
 * Coerce an unknown metadata value to a non-negative integer. Providers
 * sometimes return null/undefined when no cache event occurred; the Bedrock
 * provider in particular returns NaN for missing fields. All those should
 * funnel to 0 in the usage log.
 */
function toNumber(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return v;
}
