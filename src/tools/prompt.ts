import { tool } from 'ai';
import { z } from 'zod';
import { confirm, input, password, select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Logger } from '../logger.js';

/**
 * Schema for a single question. Used both by `prompt_user` directly (single
 * question per call) and `prompt_user_multi` (batch of questions in one call).
 *
 * `kind` is explicit so the model picks the right UI control instead of
 * inferring it from prose. The default `text` keeps simple uses simple.
 */
const QuestionSchema = z.object({
  /** Optional key — only used by prompt_user_multi to label answers. */
  key: z
    .string()
    .optional()
    .describe(
      'Identifier for this question in the returned answers object. Required for prompt_user_multi.',
    ),
  kind: z
    .enum(['text', 'choice', 'confirm', 'secret'])
    .default('text')
    .describe(
      'choice = pick one of `choices` (best for finite sets like profiles or buckets). ' +
        'confirm = yes/no decision. ' +
        'secret = same as text but input is hidden (use for tokens, MFA codes, never for AWS creds — those come from the profile). ' +
        'text = free-form input.',
    ),
  message: z.string().describe('Question shown to the user.'),
  choices: z
    .array(z.string())
    .optional()
    .describe('Required when kind = "choice". Ignored otherwise.'),
  defaultValue: z
    .string()
    .optional()
    .describe(
      'Default for kind=text/secret (typed-in default), or kind=choice (pre-selected option). ' +
        'For kind=confirm, use "yes" or "no".',
    ),
});

type Question = z.infer<typeof QuestionSchema>;

async function askOne(q: Question, logger: Logger): Promise<string> {
  logger.debug('Prompt', { kind: q.kind, message: q.message });

  // Render the question header on stderr first so the user sees a clear
  // visual break between agent reasoning and a question that wants input.
  // Inquirer renders its own prompt line; the header is a visual anchor.
  process.stderr.write('\n' + chalk.bold.cyan('? Agent needs input:') + '\n');

  switch (q.kind) {
    case 'choice': {
      if (!q.choices || q.choices.length === 0) {
        throw new Error('kind="choice" requires non-empty `choices`.');
      }
      const answer = await select({
        message: q.message,
        choices: q.choices.map((c) => ({ value: c, name: c })),
        default: q.defaultValue,
      });
      return answer;
    }
    case 'confirm': {
      const def = (q.defaultValue ?? 'yes').toLowerCase().startsWith('y');
      const answer = await confirm({ message: q.message, default: def });
      return answer ? 'yes' : 'no';
    }
    case 'secret': {
      // Inquirer's password prompt masks input. Used for short secrets like
      // MFA codes; long-lived AWS credentials should always come from the
      // user's profile, not be typed here.
      const answer = await password({ message: q.message, mask: '*' });
      return answer;
    }
    case 'text':
    default: {
      const answer = await input({ message: q.message, default: q.defaultValue });
      return answer;
    }
  }
}

/**
 * Single-question prompt. The agent calls this whenever a required parameter
 * cannot be inferred from history or discovered via the AWS CLI. Strong
 * preference for kind="choice" when the candidate set is enumerable —
 * picking from a list is faster and less error-prone than typing.
 */
export function promptUserTool(opts: { logger: Logger }) {
  return tool({
    description:
      `Ask the user ONE question to gather missing information mid-reasoning. ` +
      `Strongly prefer kind="choice" with explicit options when the set of valid answers is finite (e.g. matching profiles, bucket names, AZ ids). ` +
      `Use kind="confirm" for yes/no decisions before risky actions. ` +
      `Use kind="secret" only for short secrets typed at the moment of use (e.g. MFA codes); never solicit long-lived AWS credentials this way — they come from the user's profile. ` +
      `Use kind="text" only when free-form input is genuinely required (e.g. a new tag value the user is inventing). ` +
      `Whenever you are about to guess a value, call this tool instead.`,
    parameters: QuestionSchema,
    execute: async (q) => {
      const answer = await askOne(q, opts.logger);
      opts.logger.debug('Got answer', { answer: q.kind === 'secret' ? '***' : answer });
      return { answer };
    },
  });
}

/**
 * Multi-question prompt. Ask several related questions in one tool call —
 * cuts model round-trips when the agent already knows it needs N pieces of
 * info (e.g. "I need a source bucket, a destination bucket, and a region").
 * Each question's `key` becomes the field name in the returned object.
 */
export function promptUserMultiTool(opts: { logger: Logger }) {
  return tool({
    description:
      `Ask the user MULTIPLE related questions in one round, returning a map of key → answer. ` +
      `Use this when the agent knows up front that several values are missing and asking them together is less disruptive than one-by-one. ` +
      `Each question MUST have a unique \`key\` — that becomes the field in the returned \`answers\` object. ` +
      `Same kind options as prompt_user: text, choice, confirm, secret. ` +
      `For unrelated questions or when the answer to question A determines what to ask in question B, use prompt_user (single) instead.`,
    parameters: z.object({
      questions: z
        .array(QuestionSchema)
        .min(1)
        .max(8)
        .describe('1–8 related questions. Each must have a unique `key`.'),
    }),
    execute: async ({ questions }) => {
      // Surface duplicate keys early — the model occasionally re-uses keys
      // and the answers map would silently overwrite.
      const seen = new Set<string>();
      for (const q of questions) {
        if (!q.key) throw new Error('Every question in prompt_user_multi requires a `key`.');
        if (seen.has(q.key)) throw new Error(`Duplicate question key: ${q.key}`);
        seen.add(q.key);
      }

      // Tell the user how many questions are coming up front. Less jarring
      // than a surprise series of prompts.
      process.stderr.write(
        '\n' + chalk.dim(`(agent has ${questions.length} questions)`) + '\n',
      );

      const answers: Record<string, string> = {};
      for (const q of questions) {
        // q.key is guaranteed non-undefined here (checked above) but
        // narrowing through Set membership isn't enough for the type system.
        const key = q.key as string;
        answers[key] = await askOne(q, opts.logger);
      }
      // Don't log secret values, but do confirm the keys we got.
      const safeForLog = Object.fromEntries(
        Object.entries(answers).map(([k, v]) => {
          const q = questions.find((qq) => qq.key === k);
          return [k, q?.kind === 'secret' ? '***' : v];
        }),
      );
      opts.logger.debug('Got multi answers', safeForLog);
      return { answers };
    },
  });
}
