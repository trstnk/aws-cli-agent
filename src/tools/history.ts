import { tool } from 'ai';
import { z } from 'zod';
import type { History } from '../history.js';
import type { Logger } from '../logger.js';

export function historyTool(opts: { history: History; logger: Logger }) {
  return tool({
    description:
      'Search the local history of past requests/commands to recover context — e.g. which AWS profile was used for a given account name, common bucket/instance names, etc. Run this EARLY (typically first) when a request mentions an account, resource, or scope by name.',
    inputSchema: z.object({
      query: z
        .string()
        .describe('Search tokens. Matched against past input, commands, profile, and resources.'),
      limit: z.number().int().min(1).max(20).default(5),
    }),
    execute: async ({ query, limit }) => {
      opts.logger.debug('History search', { query, limit });
      const results = opts.history.search(query, limit);
      return {
        count: results.length,
        entries: results.map((e) => ({
          timestamp: e.timestamp,
          input: e.input,
          commands: e.commands,
          profile: e.profile,
          resources: e.resources,
        })),
      };
    },
  });
}
