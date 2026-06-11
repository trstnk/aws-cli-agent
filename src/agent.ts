import { streamText, stepCountIs } from 'ai';
import type { Logger } from './logger.js';
import type { Config } from './config.js';
import { getActiveModel } from './config.js';
import type { History, HistoryEntry } from './history.js';
import type { AuditLogger } from './audit.js';
import type { ReasoningLogger } from './reasoning.js';
import type { UsageLogger } from './usage.js';
import { createModel } from './providers.js';
import { createTools } from './tools/index.js';
import { FatalAwsCliError, UserCancelledError } from './errors.js';

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
11. Handling AWS CLI errors: if execute_aws_command returns a result with \`ok: false\` (and a non-zero exitCode), you may retry ONCE with a different approach if it's clearly worth trying — wrong region, wrong profile, missing flag, fixable typo. Don't loop trying minor variations. The host caps total run length via maxSteps; respect it. Note: unrecoverable errors (auth failure, missing credentials, permission denied, malformed request, AWS service errors) terminate the run before you'd see them, so you don't need to handle those cases — they're handled for you.
12. Keep your reasoning concise — one or two sentences per step. DO NOT summarize, restate, reformat, or describe the output of the AWS CLI. The CLI's stdout is shown to the user directly by the host program. Your only post-execution job is to stop. If anything went wrong, say so briefly; if it succeeded, you may stop without further commentary.`;

export type RunResult = {
  /** Model's free-form text. Useful only for the "no command ran" error path. */
  text: string;
  steps: number;
  /**
   * All commands the agent attempted, including ones the user declined or
   * cancelled. Used for the history log (the trail is more useful with all
   * attempts visible). For the user-facing "ran N commands" footer, use
   * `executedCommandCount` instead.
   */
  commands: string[];
  /**
   * Count of commands that actually ran (executed and produced an exit
   * code, whether 0 or non-zero). Excludes declines/cancellations so the
   * footer doesn't claim "ran 2 commands" when one was just refused.
   */
  executedCommandCount: number;
  profile: string | null;
  /** The verbatim stdout of the last execute_* call when it succeeded, or null. */
  finalOutput: string | null;
  /** The verbatim stderr of the last execute_* call if it failed, or null. */
  finalError: string | null;
  /** Did the last execute_* call run successfully? */
  ranCommand: boolean;
  /**
   * How the run ended. cli.ts uses this to pick the exit code and decide
   * whether to print the AWS stderr as a red error:
   *   - 'completed'  — normal end, model stopped on its own (exit 0)
   *   - 'cancelled'  — Ctrl-C at a prompt; cli.ts prints "cancelled by
   *                    user" on stderr and exits 130 (the canonical SIGINT
   *                    exit code)
   *   - 'fatal'      — AWS CLI returned an unrecoverable exit code
   *                    (252-255); finalError carries the stderr, cli.ts
   *                    prints it in red and exits 1
   */
  endReason: 'completed' | 'cancelled' | 'fatal';
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

  // Whether to enable prompt caching for this run. Anthropic and Bedrock
  // support an explicit `cacheControl` / `cachePoint` marker on the system
  // message — see `systemMessageProviderOptions` below. OpenAI auto-caches
  // prompts over 1,024 tokens with no opt-in needed; Google Gemini's caching
  // API is structurally different and not wired up. If caching=false in
  // config, we don't send markers anywhere.
  //
  // Note: only the system message gets cached. Marking individual tool
  // definitions does not work — the Bedrock provider drops tool-level
  // providerOptions before serializing the request. See the comment in
  // tools/index.ts. So the cached prefix is the system prompt only;
  // the tools array is sent at full cost on every request.
  const useCaching =
    config.caching && (config.provider === 'anthropic' || config.provider === 'bedrock');

  const tools = createTools({ logger, config, history, audit, record });
  const model = createModel(config, logger);
  const activeModel = getActiveModel(config);

  logger.info(`Starting agent (provider=${config.provider}, model=${activeModel})`);
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

  // Closure variables shared between the streamText callback and the
  // for-await loop below. Hoisted above streamText so the callback can read
  // them. start-step sets toolCallStepNumber to the current step number so
  // onToolCallStart knows which step to label the tool-call line with.
  let stepCounter = 0;
  let toolCallStepNumber = 0;
  let currentReasoning = '';
  let currentToolCalls: Array<{ toolName: string; args: unknown }> = [];
  let reasoningEchoed = false;

  const result = streamText({
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
    // Print the tool-call line synchronously before execute() runs. We use
    // this callback rather than the `tool-call` event in fullStream because
    // the SDK launches execute() as a concurrent task — by the time our
    // for-await loop sees `tool-call` in the stream, execute may already
    // be running (or done). This callback fires inline, immediately before
    // execute(), guaranteeing the tool-call line appears above any
    // approval prompt the tool's execute() shows.
    experimental_onToolCallStart: (event) => {
      const input = 'input' in event.toolCall ? event.toolCall.input : undefined;
      reasoning.echoToolCall(toolCallStepNumber, event.toolCall.toolName, input);
      currentToolCalls.push({ toolName: event.toolCall.toolName, args: input });
    },
  });

  // Drive the agent by consuming the full stream. The reasoning text
  // streams as text-delta events; we accumulate it and echo on text-end
  // so the user sees it BEFORE the tool-call line (which prints from the
  // onToolCallStart callback above, synchronously before execute()).
  //
  // Two execution sites collaborate to print one step:
  //   1. text-end (here) → reasoning text line
  //   2. onToolCallStart (callback above) → tool: line, then execute()

  // Terminal state for the run. The for-await loop transitions us out of
  // 'completed' (the default) into 'cancelled' on Ctrl-C, or 'fatal' on
  // an unrecoverable AWS CLI failure. cli.ts uses endReason to pick the
  // exit code and the user-facing message.
  let endReason: 'completed' | 'cancelled' | 'fatal' = 'completed';

  try {
    for await (const part of result.fullStream) {
      switch (part.type) {
        case 'start-step': {
          stepCounter += 1;
          toolCallStepNumber = stepCounter; // visible to onToolCallStart
          currentReasoning = '';
          currentToolCalls = [];
          reasoningEchoed = false;
          break;
        }
        case 'text-delta': {
          currentReasoning += part.text;
          break;
        }
        case 'text-end': {
          if (!reasoningEchoed) {
            reasoning.echoReasoning(stepCounter, currentReasoning);
            reasoningEchoed = true;
          }
          break;
        }
        case 'tool-call': {
          // Backup echo path: if text-end didn't fire (provider variant or
          // text-less step), echo whatever reasoning we have when we see
          // tool-call. The tool-call LINE itself is NOT printed here — it's
          // printed by experimental_onToolCallStart, which fires
          // synchronously before execute() and guarantees ordering above
          // any approval prompt.
          if (!reasoningEchoed) {
            reasoning.echoReasoning(stepCounter, currentReasoning);
            reasoningEchoed = true;
          }
          break;
        }
        case 'tool-error': {
          // The SDK catches errors thrown from tool.execute() and emits
          // them as tool-error events instead of rejecting the stream. So
          // we inspect every tool-error for our sentinels:
          //
          //   - UserCancelledError → throw out of the loop so the outer
          //     catch propagates it to cli.ts for "cancelled by user" + exit 130.
          //   - FatalAwsCliError → set endReason='fatal' and stop iterating.
          //     The failed call has already been recorded in executions[]
          //     by the tool (audit + record fire before the throw), so
          //     finalError further down will pick up the stderr naturally.
          //   - Anything else: ignore. Soft failures shouldn't be thrown
          //     (tools return them as results), and any other thrown error
          //     is treated as a tool-level failure the model can decide
          //     how to handle.
          if (part.error instanceof UserCancelledError) {
            throw part.error;
          }
          if (part.error instanceof FatalAwsCliError) {
            endReason = 'fatal';
            logger.warn(`Run ended on fatal AWS CLI error (exit ${part.error.exitCode}).`);
            // Flush this step's reasoning to the file log; the tool-call
            // event for this step already fired, so currentToolCalls is
            // populated. We need to break out cleanly without waiting
            // for finish-step (the SDK may still emit it, may not).
            reasoning.logStepToFile({
              step: stepCounter,
              reasoning: currentReasoning,
              toolCalls: currentToolCalls,
              finishReason: 'fatal-error',
            });
            // Stop processing the stream. We don't break out of the
            // for-await directly because we want to drain remaining events
            // for the SDK's internal cleanup; but we set a flag so we
            // don't process them.
            // Simplest: just let the loop continue. finish-step / finish
            // events will pass through harmlessly.
          }
          break;
        }
        case 'finish-step': {
          // After a fatal tool-error, finish-step still arrives for the
          // same step. The reasoning was already flushed in the tool-error
          // handler — don't double-flush. For normal steps, this is the
          // path that flushes.
          if (endReason !== 'fatal') {
            reasoning.logStepToFile({
              step: stepCounter,
              reasoning: currentReasoning,
              toolCalls: currentToolCalls,
              finishReason: part.finishReason,
            });
          }
          logger.debug(`Step ${stepCounter} finished (finishReason=${part.finishReason})`);
          break;
        }
        // Other event types (reasoning-delta for thinking-models,
        // tool-input-delta, source, file, raw, etc.) are ignored —
        // fullStream is forward-compatible.
      }
    }
  } catch (err) {
    // The for-await loop throws when we re-throw UserCancelledError above.
    // It can also throw on genuine SDK / provider failures. We distinguish:
    if (err instanceof UserCancelledError) {
      // No endReason='cancelled' assignment here: we throw immediately
      // and the post-stream code in this function never runs. cli.ts is
      // the one that recognizes UserCancelledError and exits 130 — it
      // doesn't need RunResult.endReason for that.
      if (currentReasoning.trim().length > 0 || currentToolCalls.length > 0) {
        reasoning.logStepToFile({
          step: stepCounter,
          reasoning: currentReasoning,
          toolCalls: currentToolCalls,
          finishReason: 'cancelled',
        });
      }
      logger.info('Run cancelled by user.');
      throw err;
    }
    // Genuine bug or provider failure. Let it bubble.
    throw err;
  }

  // After the stream completes (normally OR via FatalAwsCliError), pull
  // the post-stream promises. Most runs reach here with all three already
  // resolved (the stream completion is the signal). But when we caught a
  // FatalAwsCliError mid-stream, the SDK may have left these in a rejected
  // state — the stream didn't naturally complete. Defensive try/await
  // around each so we degrade gracefully: a partial RunResult with
  // whatever usage we got from steps that did complete is better than
  // crashing on a downstream `await` and losing the failure context.
  let finalText = '';
  let finalSteps: Awaited<typeof result.steps> = [];
  let totalUsage: Awaited<typeof result.totalUsage> | undefined;
  try {
    finalText = await result.text;
  } catch (err) {
    logger.debug('result.text rejected (expected after fatal/cancel)', err);
  }
  try {
    finalSteps = await result.steps;
  } catch (err) {
    logger.debug('result.steps rejected (expected after fatal/cancel)', err);
  }
  try {
    totalUsage = await result.totalUsage;
  } catch (err) {
    logger.debug('result.totalUsage rejected (expected after fatal/cancel)', err);
  }

  logger.info(`Agent finished after ${finalSteps.length} step(s)`);
  logger.debug('Final text', finalText);

  // Token usage for this invocation.
  //
  // In AI SDK v5/v6, `result.usage` is only the LAST step's tokens — confusingly
  // named. `result.totalUsage` is the sum across all steps. We want totalUsage.
  //
  // Cache hit/miss counts live in `totalUsage.inputTokenDetails`. The SDK
  // normalizes these across providers — no need to dig into provider-specific
  // metadata. The previous code path that read providerMetadata.{anthropic,
  // bedrock}.* was looking in the wrong place; cache counts in providerMetadata
  // are raw, per-provider, and located differently per provider (Bedrock nests
  // them under `usage`, Anthropic doesn't). inputTokenDetails is the
  // recommended cross-provider surface.
  //
  // We still dump per-step providerMetadata at trace level for debugging —
  // useful when caching numbers look wrong and you want to see exactly what
  // the provider returned.
  for (const step of finalSteps) {
    const pm = step.providerMetadata;
    if (pm) logger.trace(`step ${step.stepNumber} providerMetadata`, pm);
  }

  const td = totalUsage?.inputTokenDetails;
  const cacheReadTokens = toNumber(td?.cacheReadTokens);
  const cacheWriteTokens = toNumber(td?.cacheWriteTokens);

  usage.log({
    input,
    provider: config.provider,
    model: activeModel,
    steps: finalSteps.length,
    promptTokens: totalUsage?.inputTokens ?? 0,
    completionTokens: totalUsage?.outputTokens ?? 0,
    totalTokens: totalUsage?.totalTokens ?? 0,
    cacheReadTokens,
    cacheWriteTokens,
  });
  logger.debug('Usage', { ...totalUsage, cacheReadTokens, cacheWriteTokens });

  // Determine what to show the user as the final output. Rule: the LAST
  // execution wins, regardless of success — and if it failed or was
  // declined, no stdout is printed at all (we only have intermediate
  // scaffolding output left, which the user didn't ask for).
  //
  // Previously we used `find((e) => e.ok)`, which selected the most recent
  // *successful* call. That was wrong when the final intended action was
  // declined or failed: the heuristic fell back to an earlier discovery
  // call (describe-instances, list-buckets, etc.) and printed its JSON as
  // if it were the user's answer — confusing because it wasn't.
  //
  // For an empty run (no executions, e.g. the agent just talked) we have
  // nothing to print and `finalOutput` stays null.
  const last = executions.length > 0 ? executions[executions.length - 1] : null;
  const lastProfile =
    [...executions].reverse().find((e) => e.profile)?.profile ?? null;

  const finalOutput = last?.ok ? last.stdout : null;
  const finalError = last && !last.ok ? last.stderr : null;
  const ranCommand = last?.ok === true;

  const entry: HistoryEntry = {
    timestamp: new Date().toISOString(),
    input,
    commands: executions.map((e) => e.cmd),
    profile: lastProfile,
    resources: {},
    success: ranCommand,
  };
  history.append(entry);

  // "Executed" = the subprocess actually ran. Declines/cancellations use
  // exitCode -1 by convention (no process was ever spawned); successes use
  // 0, real failures use a non-zero exit. We count anything that has a real
  // exit code (≥ 0), so the user-facing footer reflects reality.
  const executedCommandCount = executions.filter((e) => e.exitCode >= 0).length;

  return {
    text: finalText,
    steps: finalSteps.length,
    commands: executions.map((e) => e.cmd),
    executedCommandCount,
    profile: lastProfile,
    finalOutput,
    finalError,
    ranCommand,
    endReason,
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
