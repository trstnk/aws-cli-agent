import { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, writeDefaultConfig, type Config } from './config.js';
import { Logger, type LogLevel } from './logger.js';
import { AuditLogger } from './audit.js';
import { ReasoningLogger } from './reasoning.js';
import { UsageLogger } from './usage.js';
import { History } from './history.js';
import { runAgent } from './agent.js';
import { FILES, PATHS, DEFAULT_SCRIPT_FOLDER } from './paths.js';

const VERSION = '0.3.0';

type GlobalOptions = {
  /** Toggles reasoning-on-console only. Does NOT change general log level. */
  verbose?: boolean;
  logLevel?: LogLevel;
  autoApprove?: boolean;
  profile?: string;
  /** Per-run override of config.defaultRegion. */
  region?: string;
  /** Force every AWS CLI call to run with inherited stdio (interactive). */
  interactive?: boolean;
};

/**
 * Apply CLI flags on top of the loaded config. Flags only override; they
 * never widen or compose with each other implicitly.
 */
function applyCliOverrides(cfg: Config, opts: GlobalOptions): Config {
  let next = cfg;
  if (opts.verbose) {
    next = { ...next, verbose: true };
  }
  if (opts.logLevel) {
    next = { ...next, logging: { ...next.logging, level: opts.logLevel } };
  }
  if (opts.autoApprove) {
    next = { ...next, autoApprove: { readOnly: true, all: true } };
  }
  if (opts.region) {
    next = { ...next, defaultRegion: opts.region };
  }
  if (opts.interactive) {
    next = { ...next, forceInteractive: true };
  }
  return next;
}

export async function main(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name('aca')
    .description(
      'aws-cli-agent (aca): agentic AI assistant that turns natural language into AWS CLI commands.',
    )
    .version(VERSION)
    .option('-v, --verbose', 'echo agent reasoning to the console as it runs')
    .option(
      '--log-level <level>',
      'override logging.level for this run: silent | error | warn | info | debug | trace',
    )
    .option(
      '--auto-approve',
      'auto-approve all commands and scripts for this run (use with care)',
    )
    .option('--profile <name>', 'hint the agent to use this AWS profile')
    .option(
      '--region <name>',
      'override defaultRegion for this run (only applies when the agent did not pick a region itself)',
    )
    .option(
      '-i, --interactive',
      'force AWS CLI commands to inherit your terminal (for shells, port-forwards, log tails). ' +
        'Common patterns auto-detect; this is the manual override.',
    );

  program
    .command('config')
    .description('Print the config file path; create defaults if missing.')
    .action(() => {
      const p = writeDefaultConfig();
      process.stdout.write(p + '\n');
    });

  program
    .command('paths')
    .description('Print paths used by aws-cli-agent.')
    .action(() => {
      const cfg = loadConfig();
      const scriptFolder = cfg.scriptFolder ?? DEFAULT_SCRIPT_FOLDER;
      const out = [
        `config dir   : ${PATHS.config}`,
        `state dir    : ${PATHS.state}`,
        '',
        `config file  : ${FILES.config}`,
        `history      : ${FILES.history}`,
        `general log  : ${FILES.log}`,
        `audit log    : ${FILES.audit}`,
        `reasoning log: ${FILES.reasoning}`,
        `usage log    : ${FILES.usage}`,
        `script folder: ${scriptFolder}`,
      ].join('\n');
      process.stdout.write(out + '\n');
    });

  program
    .command('history')
    .description('Print recent history entries.')
    .option('-n, --count <number>', 'how many entries', '10')
    .action(async (cmdOpts: { count: string }) => {
      const cfg = loadConfig();
      const h = new History(cfg.historyLimit);
      await h.load();
      const n = Number.parseInt(cmdOpts.count, 10);
      for (const e of h.recent(Number.isFinite(n) ? n : 10)) {
        process.stdout.write(`${chalk.dim(e.timestamp)} ${chalk.bold(e.input)}\n`);
        if (e.profile) process.stdout.write(`  profile: ${e.profile}\n`);
        for (const c of e.commands) {
          process.stdout.write(`  ${chalk.green(c)}\n`);
        }
      }
    });

  program
    .command('run', { isDefault: true })
    .description('Run a natural-language request (default).')
    .argument('<request...>', 'natural-language request')
    .action(async (requestArgs: string[]) => {
      const globalOpts = program.opts<GlobalOptions>();
      const request = requestArgs.join(' ').trim();
      if (!request) {
        program.help();
        return;
      }

      const cfg = applyCliOverrides(loadConfig(), globalOpts);
      const logger = new Logger(cfg.logging.level);
      const audit = new AuditLogger(cfg.logging.auditLog);
      const reasoning = new ReasoningLogger({
        enabled: cfg.logging.reasoningLog,
        consoleEcho: cfg.verbose,
      });
      const usage = new UsageLogger(cfg.logging.usageLog);
      const history = new History(cfg.historyLimit);
      await history.load();

      const finalRequest = globalOpts.profile
        ? `${request}\n(Use AWS profile: ${globalOpts.profile})`
        : request;

      try {
        const result = await runAgent({
          input: finalRequest,
          config: cfg,
          logger,
          history,
          audit,
          reasoning,
          usage,
        });

        // Output policy: stdout is reserved for the AWS CLI's verbatim output.
        // Everything else (reasoning, prompts, status, commands executed) goes
        // to stderr via the logger. This keeps `aca ... | jq` and similar
        // pipelines working as if the user ran aws directly.
        // Decide what reaches the user's terminal:
        // - Successful final command → its stdout goes to stdout (pipeable).
        // - Genuine failure (non-zero exit, spawn error, etc.) → its stderr
        //   goes to stderr in red, and the process exits 1.
        // - User declined/cancelled → quiet exit. The agent's text response
        //   (if any) tells the user the action was cancelled; no red noise.
        // - Nothing useful → fall back to the agent's final text, if any.
        const wasDeclined =
          result.finalError === '[declined by user]' ||
          result.finalError === '[cancelled by user]';

        if (result.ranCommand && result.finalOutput !== null) {
          process.stdout.write(result.finalOutput);
          if (!result.finalOutput.endsWith('\n')) process.stdout.write('\n');
        } else if (result.finalError && !wasDeclined) {
          process.stderr.write(chalk.red(result.finalError));
          if (!result.finalError.endsWith('\n')) process.stderr.write('\n');
          process.exitCode = 1;
        } else if (result.text.trim().length > 0) {
          process.stderr.write(result.text.trim() + '\n');
        }

        // Footer counts only commands that actually executed. Declined or
        // cancelled commands appear in `result.commands` for the history
        // log but don't count as "ran" since no subprocess was started.
        if (result.executedCommandCount > 0) {
          const tag = result.profile ? `[${result.profile}]` : '';
          const cmds =
            result.executedCommandCount === 1
              ? '1 command'
              : `${result.executedCommandCount} commands`;
          process.stderr.write(chalk.dim(`\nran ${cmds} ${tag}\n`));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Agent failed', msg);
        process.stderr.write(chalk.red('Error: ') + msg + '\n');
        process.exitCode = 1;
      } finally {
        logger.close();
        audit.close();
        reasoning.close();
        usage.close();
      }
    });

  await program.parseAsync(argv);
}
