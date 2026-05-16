import { spawn } from 'node:child_process';
import { tool } from 'ai';
import { z } from 'zod';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';

const READ_ONLY_VERBS = [
  /^describe-/,
  /^list-/,
  /^get-/,
  /^lookup-/,
  /^batch-get-/,
  /^head-/,
  /^filter-/,
  /^scan$/,
  /^query$/,
];

const READ_ONLY_FULL = [
  /^s3\s+ls(\s|$)/,
];

/**
 * Commands that need direct terminal access — either because they open a TTY
 * (interactive shells), bind a local port and wait for connections, or stream
 * indefinitely until the user interrupts. For these we connect the child's
 * stdio to the parent's terminal instead of capturing stdout/stderr into
 * strings. The agent doesn't get to "see" the output, which is correct:
 * data flow is user ↔ AWS, not user ↔ agent ↔ AWS.
 *
 * If a command should be interactive but isn't listed here, the user can
 * force it with the `--interactive` / `-i` CLI flag or the agent can set
 * `interactive: true` in the tool call.
 */
const INTERACTIVE_FULL = [
  // SSM Session Manager — opens a shell or a port-forward listener. Both
  // need stdio inheritance: the shell case needs stdin connected, the
  // port-forward case needs to print "Waiting for connections" and survive.
  /^ssm\s+start-session(\s|$)/,
  // CloudShell — interactive shell in AWS console replica.
  /^cloudshell\s+(start|connect)(-.*|\s|$)/,
  // ECS Exec — runs a command inside a container, often a shell.
  /^ecs\s+execute-command(\s|$)/,
  // EKS exec via aws — wraps kubectl exec for cluster pods.
  /^eks\s+(exec|kubeconfig)(\s|$)/,
  // CloudWatch Logs tail with --follow runs until Ctrl-C.
  /^logs\s+tail(\s|$).*--follow/,
];

function isReadOnly(args: string[]): boolean {
  const joined = args.join(' ');
  if (READ_ONLY_FULL.some((re) => re.test(joined))) return true;
  const verb = args[1];
  if (verb && READ_ONLY_VERBS.some((re) => re.test(verb))) return true;
  return false;
}

function isInteractive(args: string[]): boolean {
  const joined = args.join(' ');
  return INTERACTIVE_FULL.some((re) => re.test(joined));
}

function shellQuote(arg: string): string {
  if (/^[a-zA-Z0-9_\-/.=:]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function extractProfile(args: string[]): string | null {
  const i = args.indexOf('--profile');
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function hasRegion(args: string[]): boolean {
  return args.includes('--region');
}

// Default cap is generous because list/describe output for a real AWS account
// can easily exceed 50 KB (hundreds of buckets, dozens of instances with full
// describe-instances JSON). The model needs the full data to surface it to the
// user. If you hit memory pressure, lower this — but the model's own context
// window is the real limiter.
function truncate(s: string, max = 200_000): string {
  return s.length <= max ? s : s.slice(0, max) + `\n... [truncated ${s.length - max} bytes]`;
}

/**
 * Run aws CLI with stdout/stderr captured into strings. Right for discovery
 * calls where the agent (and the host program) need to read the output.
 */
function runCaptured(
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

/**
 * Run aws CLI with the child's stdio connected directly to the parent's
 * terminal. Used for interactive sessions (ssm start-session shells),
 * commands that bind local ports and wait (ssm port-forwarding sessions),
 * and long-running streams (logs tail --follow).
 *
 * Returns no stdout/stderr — the bytes went straight to the user's terminal
 * and we never see them. This is correct: data flow is user ↔ AWS, not
 * user ↔ agent ↔ AWS.
 */
function runInteractive(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      env: process.env,
      stdio: 'inherit', // child reuses parent's stdin/stdout/stderr
    });
    proc.on('error', reject);
    proc.on('close', (code) =>
      // We can't observe stdout/stderr — they went to the user's terminal.
      resolve({ stdout: '', stderr: '', code: code ?? 0 }),
    );
  });
}

export function awsCliTool(opts: {
  logger: Logger;
  config: Config;
  audit: import('../audit.js').AuditLogger;
  record: (entry: import('./index.js').ExecutionRecord) => void;
}) {
  return tool({
    description:
      'Execute an AWS CLI command. `args` does NOT include the leading "aws" - just the subcommand and parameters, e.g. ["ec2","describe-instances","--profile","my-profile","--output","json"]. ALWAYS use --output json on discovery calls so you can parse results. Read-only commands (describe-/list-/get-/s3 ls) auto-approve if allowed by config; mutating commands always prompt. ' +
      'Set `interactive: true` for commands that need direct terminal access — interactive shells (ssm start-session, ecs execute-command), port-forwarding sessions, log tails with --follow. Common interactive patterns auto-detect, but you can force it. When interactive, the child process is connected directly to the user\'s terminal; you will not see the output and should not attempt to parse it.',
    inputSchema: z.object({
      args: z.array(z.string()).min(1).describe('Arguments after the "aws" binary.'),
      purpose: z
        .string()
        .describe('Brief explanation of why this call is being made (shown to the user).'),
      interactive: z
        .boolean()
        .optional()
        .describe(
          'Force interactive mode (inherit terminal stdio). Use for shells, port-forwards, and long-running streams. ' +
            'If unset, the host auto-detects common patterns (ssm start-session, ecs execute-command, logs tail --follow, etc.).',
        ),
    }),
    execute: async ({ args, purpose, interactive }) => {
      // Inject defaultRegion if the agent didn't pass --region.
      let effectiveArgs = args;
      if (!hasRegion(args) && opts.config.defaultRegion) {
        effectiveArgs = [...args, '--region', opts.config.defaultRegion];
      }
      const display = 'aws ' + effectiveArgs.map(shellQuote).join(' ');
      opts.logger.info(`AWS CLI requested: ${purpose}`);
      opts.logger.debug('Command', display);

      // Decide interactive mode. Priority: explicit override on the tool
      // call > CLI flag (via config.forceInteractive) > pattern detection.
      // The CLI flag is the user's escape hatch for cases not in our
      // INTERACTIVE_FULL list.
      const useInteractive =
        interactive === true ||
        opts.config.forceInteractive === true ||
        isInteractive(effectiveArgs);

      const readOnly = isReadOnly(effectiveArgs);
      // Interactive commands are never auto-approved. The user is about to
      // hand their terminal over to a subprocess — that always warrants a
      // confirmation, regardless of autoApprove settings.
      const autoApprove =
        !useInteractive &&
        (opts.config.autoApprove.all || (opts.config.autoApprove.readOnly && readOnly));

      if (!autoApprove) {
        process.stderr.write('\n');
        process.stderr.write(`${chalk.bold('  Reason:  ')}${purpose}\n`);
        process.stderr.write(`${chalk.bold('  Command: ')}${chalk.green(display)}\n`);
        if (useInteractive) {
          process.stderr.write(
            `${chalk.bold('  Mode:    ')}${chalk.yellow('interactive')} (your terminal will be connected to the command)\n`,
          );
        }
        const ok = await confirm({ message: 'Execute this command?', default: true });
        if (!ok) {
          opts.logger.warn('User declined command');
          return { ok: false, declined: true, error: 'User declined to execute this command.' };
        }
      } else {
        opts.logger.debug(`Auto-approved (${readOnly ? 'read-only' : 'all'})`);
      }

      const profile = extractProfile(effectiveArgs);

      try {
        const { stdout, stderr, code } = useInteractive
          ? await runInteractive('aws', effectiveArgs)
          : await runCaptured('aws', effectiveArgs);

        opts.logger.debug('Exit code', code);
        if (!useInteractive) {
          opts.logger.trace('stdout', stdout);
          if (code !== 0) {
            opts.logger.warn(`AWS CLI failed (exit ${code})`);
            opts.logger.trace('stderr', stderr);
          }
        } else if (code !== 0) {
          opts.logger.warn(`Interactive AWS CLI exited non-zero (${code})`);
        }

        // Audit captures whatever we have. For interactive runs stdout/stderr
        // are empty — that's accurate, the bytes went to the terminal — and
        // the audit entry serves as a record that "an interactive session
        // ran" rather than a transcript of what happened in it.
        opts.audit.logCommand({
          cmd: display,
          profile,
          exitCode: code,
          ok: code === 0,
          stdout: useInteractive ? '[interactive session — output not captured]' : stdout,
          stderr: useInteractive ? '' : stderr,
        });
        opts.record({
          cmd: display,
          profile,
          // For interactive runs, give the host CLI a one-line summary to
          // emit instead of empty output. Users finishing an SSM session see
          // their shell ouptut as it happens; this just confirms it ended.
          stdout: useInteractive
            ? `[interactive session ended, exit ${code}]\n`
            : stdout,
          stderr: useInteractive ? '' : stderr,
          exitCode: code,
          ok: code === 0,
        });

        // For the agent's context, return a clear signal that interactive
        // mode ran so it doesn't try to parse fictional stdout.
        if (useInteractive) {
          return {
            ok: code === 0,
            exitCode: code,
            interactive: true,
            note: 'Interactive session ran. Output went directly to the user\'s terminal and was not captured. Do not summarize or describe its contents.',
          };
        }
        return {
          ok: code === 0,
          exitCode: code,
          stdout: truncate(stdout),
          stderr: truncate(stderr),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        opts.logger.error('Failed to spawn aws CLI', msg);
        opts.audit.logCommand({
          cmd: display,
          profile,
          exitCode: -1,
          ok: false,
          stdout: '',
          stderr: msg,
        });
        opts.record({
          cmd: display,
          profile,
          stdout: '',
          stderr: msg,
          exitCode: -1,
          ok: false,
        });
        return { ok: false, error: msg };
      }
    },
  });
}
