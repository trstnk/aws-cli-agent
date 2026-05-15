import fs from 'node:fs';
import { FILES, PATHS } from './paths.js';

const LEVELS = ['silent', 'error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LEVELS)[number];

function safeStringify(data: unknown): string {
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

/**
 * The general operational logger. Writes ONLY to `general.log`. Never echoes
 * to the console — console output is reserved for:
 *
 *   1. The AWS CLI's verbatim stdout (on stdout).
 *   2. Agent reasoning steps via ReasoningLogger.consoleEcho, gated by the
 *      `verbose` config / `--verbose` CLI flag (on stderr).
 *   3. Approval prompts, errors, and the final status line (on stderr,
 *      written directly by callers in cli.ts and the execute tools).
 *
 * Everything operational (agent start, exit codes, debug info, warnings)
 * goes exclusively to general.log. To watch it live:
 *   tail -f ~/.local/state/aws-cli-agent/general.log
 */
export class Logger {
  private readonly level: number;
  private readonly fileStream: fs.WriteStream | null;

  constructor(level: LogLevel = 'error') {
    this.level = LEVELS.indexOf(level);
    if (level !== 'silent') {
      fs.mkdirSync(PATHS.state, { recursive: true });
      this.fileStream = fs.createWriteStream(FILES.log, { flags: 'a' });
    } else {
      this.fileStream = null;
    }
  }

  private write(lvl: Exclude<LogLevel, 'silent'>, msg: string, data?: unknown) {
    const lvlIdx = LEVELS.indexOf(lvl);
    if (lvlIdx === 0 || lvlIdx > this.level) return;

    const ts = new Date().toISOString();
    const dataStr = data !== undefined ? ' ' + safeStringify(data) : '';
    const line = `[${ts}] ${lvl.toUpperCase()} ${msg}${dataStr}\n`;
    this.fileStream?.write(line);
  }

  error(msg: string, data?: unknown) {
    this.write('error', msg, data);
  }
  warn(msg: string, data?: unknown) {
    this.write('warn', msg, data);
  }
  info(msg: string, data?: unknown) {
    this.write('info', msg, data);
  }
  debug(msg: string, data?: unknown) {
    this.write('debug', msg, data);
  }
  trace(msg: string, data?: unknown) {
    this.write('trace', msg, data);
  }

  close() {
    this.fileStream?.end();
  }
}
