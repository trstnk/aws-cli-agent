import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { select } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';
import { DEFAULT_SCRIPT_FOLDER } from '../paths.js';

function runProcess(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env: process.env });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    proc.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

function truncate(s: string, max = 200_000): string {
  return s.length <= max ? s : s.slice(0, max) + `\n... [truncated]`;
}

function indent(s: string, prefix: string): string {
  return s
    .split('\n')
    .map((l) => prefix + l)
    .join('\n');
}

/**
 * Compute a filesystem-friendly filename for a saved script.
 * Combines a timestamp (so files sort chronologically) with a short slug
 * derived from the purpose (so a directory listing is humanly scannable).
 */
function scriptFileName(purpose: string): string {
  const slug = purpose
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'script';
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/T/, '_')
    .slice(0, 19);
  return `${ts}_${slug}.sh`;
}

export function bashScriptTool(opts: {
  logger: Logger;
  config: Config;
  audit: import('../audit.js').AuditLogger;
  record: (entry: import('./index.js').ExecutionRecord) => void;
}) {
  return tool({
    description:
      'Execute a bash script. Use this for multi-step / multi-account workflows that need looping, jq filtering, or composition (e.g. "list all RDS Aurora databases in all accounts of org X"). The user is prompted to (a) execute the script now, (b) save it to disk for later review or scheduled execution, or (c) cancel. Always start scripts with `set -euo pipefail`.',
    parameters: z.object({
      script: z.string().min(1).describe('Full bash script source.'),
      purpose: z.string().describe('What this script accomplishes.'),
    }),
    execute: async ({ script, purpose }) => {
      opts.logger.info(`Bash script requested: ${purpose}`);
      opts.logger.debug('Script', script);

      // Show what would run so the user can make an informed choice.
      process.stderr.write('\n');
      process.stderr.write(`${chalk.bold('  Reason: ')}${purpose}\n`);
      process.stderr.write(`${chalk.bold('  Script:')}\n`);
      process.stderr.write(chalk.green(indent(script, '    ')) + '\n');

      // The save-to-disk option respects the configured folder, or falls back
      // to the XDG default. Compute the would-be path *before* prompting so
      // the user can see exactly where it'll land.
      const scriptFolder = opts.config.scriptFolder ?? DEFAULT_SCRIPT_FOLDER;
      const savePath = path.join(scriptFolder, scriptFileName(purpose));

      // Scripts always go through the three-way prompt regardless of
      // autoApprove. Scripts are arbitrary code with shell-level capability
      // — auto-approving them would defeat a primary safety boundary. The
      // autoApprove flag remains in effect for individual aws CLI commands
      // (where read-only is a meaningful and enforceable category).
      const action = await select<'execute' | 'save' | 'cancel'>({
        message: 'What would you like to do with this script?',
        choices: [
          { value: 'execute', name: 'Execute now' },
          { value: 'save', name: `Save to disk (${savePath})` },
          { value: 'cancel', name: 'Cancel' },
        ],
        default: 'execute',
      });

      if (action === 'cancel') {
        opts.logger.warn('User cancelled script');
        return {
          ok: false,
          declined: true,
          error: 'User cancelled. No script was executed or saved.',
        };
      }

      if (action === 'save') {
        try {
          fs.mkdirSync(scriptFolder, { recursive: true });
          fs.writeFileSync(savePath, script, { mode: 0o700 });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          opts.logger.error('Failed to save script', msg);
          return { ok: false, error: `Failed to save script: ${msg}` };
        }
        opts.logger.info(`Script saved to ${savePath}`);
        // Still audit the save action so the trail is complete. exitCode=0
        // is honest here: the user-visible action succeeded.
        opts.audit.logScript({
          cmd: `saved ${savePath}`,
          profile: null,
          exitCode: 0,
          ok: true,
          stdout: '',
          stderr: '',
          script,
        });
        // Record so the CLI can print a confirmation in place of stdout —
        // the script wasn't run, so there's no real stdout to forward.
        opts.record({
          cmd: `saved ${savePath}`,
          profile: null,
          stdout: `Script saved to ${savePath}\n`,
          stderr: '',
          exitCode: 0,
          ok: true,
        });
        return {
          ok: true,
          saved: true,
          path: savePath,
          stdout: `Script saved to ${savePath}`,
        };
      }

      // action === 'execute' — same path as before.
      const tmp = path.join(os.tmpdir(), `aws-cli-agent-${Date.now()}-${process.pid}.sh`);
      fs.writeFileSync(tmp, script, { mode: 0o700 });
      const cmdLabel = `bash ${tmp}`;

      try {
        const { stdout, stderr, code } = await runProcess('bash', [tmp]);
        opts.logger.debug('Script exit code', code);
        opts.logger.trace('stdout', stdout);
        if (code !== 0) opts.logger.trace('stderr', stderr);
        opts.audit.logScript({
          cmd: cmdLabel,
          profile: null,
          exitCode: code,
          ok: code === 0,
          stdout,
          stderr,
          script,
        });
        opts.record({
          cmd: cmdLabel,
          profile: null,
          stdout,
          stderr,
          exitCode: code,
          ok: code === 0,
        });
        return {
          ok: code === 0,
          exitCode: code,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
        };
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch {
          /* ignore */
        }
      }
    },
  });
}
