import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import type { Logger } from '../logger.js';

export function listProfilesTool(opts: { logger: Logger }) {
  return tool({
    description:
      'List AWS named profiles configured locally in ~/.aws/config and ~/.aws/credentials. Use this when the user references an account by name and history did not resolve it.',
    inputSchema: z.object({}),
    execute: async () => {
      opts.logger.debug('Listing AWS profiles');
      const profiles = new Set<string>();
      const files = [
        path.join(os.homedir(), '.aws', 'config'),
        path.join(os.homedir(), '.aws', 'credentials'),
      ];
      for (const f of files) {
        if (!fs.existsSync(f)) continue;
        const content = fs.readFileSync(f, 'utf8');
        // [profile foo] in config, [foo] in credentials
        const re = /^\s*\[(?:profile\s+)?([^\]]+)\]/gm;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) {
          const name = m[1].trim();
          if (name && name !== 'default') profiles.add(name);
          if (name === 'default') profiles.add('default');
        }
      }
      const result = Array.from(profiles).sort();
      opts.logger.trace('Profiles found', result);
      return { profiles: result, count: result.length };
    },
  });
}
