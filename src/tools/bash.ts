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
import { wrapPrompt } from '../errors.js';
import { READ_ONLY_FULL, READ_ONLY_VERBS } from './aws-cli.js';

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
 * Match an `aws <service> <verb> ...` invocation anywhere within a line.
 * The lookbehind is intentionally permissive — it matches `aws` at the
 * start of the line, after a pipe (`| aws ...`), after `time aws ...`,
 * after `env VAR=val aws ...`, etc. We don't try to be a full shell
 * parser: that's overkill for a syntax-highlight feature. False positives
 * (e.g. the literal string `"use aws ec2 ..."` inside an echo) get
 * highlighted too, but that's preferable to false negatives — and the
 * surrounding context usually makes them visually distinguishable.
 *
 * Captures three groups: service (group 1), verb (group 2), and the rest
 * of the args up to end of line or a shell metacharacter that ends a
 * command (group 3). We stop the arg span at `|`, `;`, `&`, `)`, and `>` /
 * `<` redirections so we don't highlight half of the next pipeline stage.
 */
const AWS_CALL_RE =
  /\baws\s+([a-z][a-z0-9-]*)\s+([a-z][a-z0-9-]*)((?:\s+[^|;&)<>\n]*)?)/g;

/**
 * Decide whether an `aws <service> <verb>` invocation is read-only. Uses
 * the same classification as the per-command auto-approve path so the
 * highlighting matches the runtime behavior: if the highlight is light
 * blue, the command would auto-approve with `autoApprove.readOnly: true`
 * if it were a standalone tool call.
 */
function isAwsCallReadOnly(service: string, verb: string, restOfArgs: string): boolean {
  // READ_ONLY_FULL patterns match against `service verb [args...]`.
  // We pass the same shape to mirror runtime behavior.
  const full = `${service} ${verb}${restOfArgs}`;
  if (READ_ONLY_FULL.some((re) => re.test(full))) return true;
  if (READ_ONLY_VERBS.some((re) => re.test(verb))) return true;
  return false;
}

/**
 * Color the AWS CLI invocations inside a script. Read-only calls
 * (describe-, list-, get-, etc.) render in light blue; mutating calls
 * (delete-, terminate-, create-, etc.) render in yellow. Non-AWS portions
 * of each line stay in the script body's default green wrap.
 *
 * Implementation note: chalk colors don't nest the way you'd hope. If we
 * wrapped the whole script in `chalk.green()` and then embedded blue/yellow
 * spans inside it, the inner spans' closing reset (\u001b[39m) would
 * disable the green for the remainder of the string. To avoid that, we
 * render each line piece by piece, explicitly re-applying green to the
 * non-highlighted spans.
 */
function highlightAwsCalls(script: string): string {
  return script
    .split('\n')
    .map((line) => {
      // Walk the line in pieces, emitting green for plain text and a
      // distinct color for each AWS invocation. We use the regex's
      // exec-loop position tracking to splice the line.
      AWS_CALL_RE.lastIndex = 0;
      let out = '';
      let cursor = 0;
      let m: RegExpExecArray | null;
      while ((m = AWS_CALL_RE.exec(line)) !== null) {
        // The `aws` keyword itself isn't in the capture groups — find it
        // by scanning backward from the service position.
        const matchStart = m.index;
        const service = m[1];
        const verb = m[2];
        const restOfArgs = m[3] ?? '';
        const readOnly = isAwsCallReadOnly(service, verb, restOfArgs);

        // Pre-`aws` text (e.g. `| `, `time `, or empty for start-of-line)
        // stays green.
        if (matchStart > cursor) {
          out += chalk.green(line.slice(cursor, matchStart));
        }

        // The `aws <service> <verb>` triple gets the distinct color.
        // restOfArgs (the flags and values) stays green — flags are the
        // boring part, the verb is what the user needs to verify.
        // Inverse (swaps fg/bg) produces a "highlighter strip" look: the
        // background takes the color and the text shows through in the
        // terminal's default foreground. Much more visible against the
        // green script body than colored text alone would be — the eye
        // snaps to a block of color faster than to a colored word.
        // Green strip for read-only (matches the safe/discovery feel of
        // the surrounding green script body); red strip for mutating
        // (the classic "stop and look" signal).
        const highlight = readOnly
          ? chalk.inverse.blueBright
          : chalk.inverse.yellowBright;
        out += highlight(`aws ${service} ${verb}`);
        if (restOfArgs.length > 0) {
          out += chalk.green(restOfArgs);
        }
        cursor = matchStart + m[0].length;
      }
      // Trailing text after the last match stays green.
      if (cursor < line.length) {
        out += chalk.green(line.slice(cursor));
      }
      // If no AWS call was found in the line, fall through with the whole
      // line in green — same as the old uniform-green behavior.
      if (out === '') {
        out = chalk.green(line);
      }
      return out;
    })
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
    inputSchema: z.object({
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
      // Render the script with AWS calls highlighted. Read-only calls
      // (describe-, list-, get-, etc.) render in light blue; mutating calls
      // (delete-, terminate-, create-, etc.) render in yellow. Everything
      // else stays green. See highlightAwsCalls for the parser caveats.
      process.stderr.write(highlightAwsCalls(indent(script, '    ')) + '\n');

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
      const action = await wrapPrompt((ctx) =>
        select<'execute' | 'save' | 'cancel'>(
          {
            message: 'What would you like to do with this script?',
            choices: [
              { value: 'execute', name: 'Execute now' },
              { value: 'save', name: `Save to disk (${savePath})` },
              { value: 'cancel', name: 'Cancel' },
            ],
            default: 'execute',
          },
          ctx,
        ),
      );

      if (action === 'cancel') {
        opts.logger.warn('User cancelled script');
        // Record the cancelled call so the agent's end-of-run logic sees
        // refusal as the final action, not an earlier successful step.
        // See the parallel comment in aws-cli.ts for the reasoning.
        const cmdLabel = `[bash script: ${purpose}]`;
        opts.audit.logCommand({
          cmd: cmdLabel,
          profile: null,
          exitCode: -1,
          ok: false,
          stdout: '',
          stderr: '[cancelled by user]',
        });
        opts.record({
          cmd: cmdLabel,
          profile: null,
          stdout: '',
          stderr: '[cancelled by user]',
          exitCode: -1,
          ok: false,
        });
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
