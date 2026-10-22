import { createMCPClient } from '@ai-sdk/mcp';
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';
import { UserCancelledError, wrapPrompt } from '../errors.js';

/** Per-request timeout for the MCP server (initialize + tool call each). */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Cap on documentation text handed back to the model. Doc pages are long and
 * every byte lands in the context of every following step, so this is much
 * tighter than the AWS CLI output cap. The model can page with `startIndex`.
 */
const MAX_READ_LENGTH = 8_000;

function truncate(s: string, max = 20_000): string {
  return s.length <= max ? s : s.slice(0, max) + `\n... [truncated ${s.length - max} bytes]`;
}

/**
 * Search hits that are never what a CLI user needs: language-SDK references
 * (same operation, wrong syntax) and AWS CLI v1 pages (duplicates of the v2
 * pages under cli/latest). `reference_documentation` ranks these highly for
 * some services, crowding out the CLI pages.
 */
const NON_CLI_URL =
  /docs\.aws\.amazon\.com\/(sdk-for-[^/]+|boto3|botocore|AWSJavaSDK|AWSJavaScriptSDK|sdkfornet|aws-sdk-php|cdk\/api|cli\/v1)\//;

/**
 * Pull the text parts out of an MCP tool result and JSON-parse them. The
 * AWS Knowledge server wraps its payload as `{ content: { result: [...] } }`
 * inside a single text part, and reports failures as `{ errorMessage }`.
 * `items` is null when the shape is unexpected so the caller can fall back
 * to the raw text.
 */
function parseResult(raw: unknown): {
  items: Record<string, unknown>[] | null;
  text: string;
  error: string | null;
} {
  const { content, isError } = raw as { content?: unknown; isError?: boolean };
  const text = Array.isArray(content)
    ? content
        .filter((c): c is { type: 'text'; text: string } => c?.type === 'text' && typeof c.text === 'string')
        .map((c) => c.text)
        .join('\n')
    : '';
  try {
    const parsed = JSON.parse(text) as { content?: { result?: unknown }; errorMessage?: unknown };
    if (typeof parsed.errorMessage === 'string') {
      return { items: null, text, error: parsed.errorMessage };
    }
    const result = parsed.content?.result;
    return {
      items: Array.isArray(result) ? (result as Record<string, unknown>[]) : null,
      text,
      error: isError ? text : null,
    };
  } catch {
    return { items: null, text, error: isError ? text : null };
  }
}

/**
 * Open a short-lived client, run one tool call, close. Doc lookups are rare
 * (most commands are obvious to the model), so a connection per call is
 * cheaper in complexity than threading a client lifecycle through the agent
 * loop — and nothing is left open to keep the process alive after the run.
 */
async function callKnowledgeServer(
  url: string,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = await createMCPClient({
    transport: { type: 'http', url },
    clientName: 'aws-cli-agent',
    initializationOptions: { timeout: REQUEST_TIMEOUT_MS },
  });
  try {
    return await client.callTool({ name, arguments: args, options: { timeout: REQUEST_TIMEOUT_MS } });
  } finally {
    await client.close().catch(() => {
      /* ignore — the call already finished or failed */
    });
  }
}

/**
 * Show what is about to be sent to the Knowledge server and ask the user to
 * allow it. Unlike AWS CLI calls, a lookup can't change anything — the gate
 * exists because the query text leaves the machine, so the user gets to
 * check it for account IDs, resource names, or other data before it does.
 * Skipped only with `autoApprove.all` (also set by --auto-approve):
 * `autoApprove.readOnly` doesn't count, since a lookup's risk is the data
 * it sends, not a change in AWS.
 */
async function approveLookup(
  opts: { logger: Logger; config: Config },
  label: string,
  value: string,
): Promise<boolean> {
  if (opts.config.autoApprove.all) {
    opts.logger.debug('Docs lookup auto-approved');
    return true;
  }
  process.stderr.write('\n');
  process.stderr.write(`${chalk.bold(`  ${label}`)}${chalk.green(value)}\n`);
  process.stderr.write(`${chalk.bold('  Sent to: ')}${opts.config.docs.url}\n`);
  return wrapPrompt((ctx) =>
    confirm({ message: 'Send this AWS documentation lookup?', default: true }, ctx),
  );
}

const DECLINED = {
  ok: false,
  declined: true,
  error: 'User declined the documentation lookup. Continue without it; do not retry the same lookup.',
};

export function awsDocsTool(opts: { logger: Logger; config: Config }): Tool {
  const url = opts.config.docs.url;
  return tool({
    description:
      'Search and read official AWS documentation (AWS Knowledge MCP server). Use ONLY when the correct AWS CLI command is not obvious: unsure which service/subcommand covers the task, unsure of exact flag names, required parameters, or the JSON shape of a structured argument (e.g. --cli-input-json, --filters, lifecycle/policy documents), or to decode a CLI error you cannot explain. Do NOT use it for commands you already know, and never to answer general AWS questions. ' +
      'action="search" with `query` returns ranked page chunks (title, url, verbatim text) that usually already contain the answer. action="read" with `url` returns the page as markdown: use an exact URL from a search result, or the CLI reference page https://docs.aws.amazon.com/cli/latest/reference/<service>/<command>.html (synopsis, options, examples) when you know the command but not its flags; continue a truncated page with `startIndex` = the returned `endIndex`. ' +
      'Queries are sent to an external AWS service and may need user approval first: never put account IDs, resource names, ARNs, or other user data in `query`. If the user declines, continue without the docs.',
    inputSchema: z.object({
      action: z.enum(['search', 'read']).describe('search = find relevant doc chunks; read = fetch one page.'),
      query: z
        .string()
        .optional()
        .describe('Required for search. Keywords, e.g. "aws cli ec2 describe-instances filter by tag". Preserve exact error strings verbatim.'),
      url: z.string().optional().describe('Required for read. Exact doc URL from a search result.'),
      startIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('read only: character offset to continue from (previous endIndex).'),
    }),
    execute: async ({ action, query, url: docUrl, startIndex }) => {
      try {
        if (action === 'search') {
          if (!query) return { ok: false, error: 'action="search" requires `query`.' };
          if (!(await approveLookup(opts, 'Docs search: ', query))) {
            opts.logger.warn('User declined docs search');
            return DECLINED;
          }
          opts.logger.info(`AWS docs search: ${query}`);
          const raw = await callKnowledgeServer(url, 'aws___search_documentation', {
            search_phrase: query,
            // CLI reference pages and code examples live under this topic.
            topics: ['reference_documentation'],
            // Over-fetch so there is something left after dropping SDK noise.
            limit: 8,
          });
          const { items, text, error } = parseResult(raw);
          if (error) return { ok: false, error: `Documentation search failed: ${truncate(error, 1_000)}` };
          if (!items) return { ok: true, raw: truncate(text) };
          // Drop "skill" entries (guided workflows for the server's own
          // retrieve_skill tool) — they carry no page text we can use.
          const pages = items.filter((r) => typeof r.context === 'string');
          const cliPages = pages.filter((r) => !NON_CLI_URL.test(String(r.url)));
          // If filtering leaves nothing, SDK pages still beat no answer: the
          // parameter names and shapes match the CLI's.
          const results = (cliPages.length > 0 ? cliPages : pages)
            .slice(0, 4)
            .map((r) => ({ title: r.title, url: r.url, context: truncate(r.context as string, 4_000) }));
          opts.logger.debug(`AWS docs search returned ${results.length} result(s)`);
          return { ok: true, results };
        }

        // The schema only admits search/read, but don't let an unexpected
        // value fall through to a read call.
        if (action !== 'read') return { ok: false, error: `Unknown action "${String(action)}".` };

        if (!docUrl) return { ok: false, error: 'action="read" requires `url`.' };
        if (!(await approveLookup(opts, 'Docs read:   ', docUrl))) {
          opts.logger.warn('User declined docs read');
          return DECLINED;
        }
        opts.logger.info(`AWS docs read: ${docUrl}`);
        const raw = await callKnowledgeServer(url, 'aws___read_documentation', {
          requests: [{ url: docUrl, max_length: MAX_READ_LENGTH, start_index: startIndex ?? 0 }],
        });
        const { items, text, error } = parseResult(raw);
        if (error) return { ok: false, error: `Documentation read failed: ${truncate(error, 1_000)}` };
        const page = items?.[0];
        if (!page) return { ok: true, raw: truncate(text) };
        if (page.status !== 'SUCCESS') {
          return { ok: false, error: `Documentation read failed (${String(page.error_code ?? page.status)}).` };
        }
        return {
          ok: true,
          url: page.redirected_url ?? page.url,
          content: page.content,
          totalLength: page.total_length,
          endIndex: page.end_index,
          truncated: page.truncated,
        };
      } catch (err) {
        // Ctrl-C at the approval prompt must end the run, not become a
        // soft lookup failure.
        if (err instanceof UserCancelledError) throw err;
        // Soft failure: the docs are a convenience. The model can still build
        // the command from its own knowledge or ask the user.
        const msg = err instanceof Error ? err.message : String(err);
        opts.logger.warn(`AWS docs lookup failed: ${msg}`);
        return { ok: false, error: `Documentation lookup failed: ${msg}` };
      }
    },
  });
}
