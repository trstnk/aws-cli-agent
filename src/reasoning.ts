import fs from 'node:fs';
import chalk from 'chalk';
import { FILES, PATHS } from './paths.js';

/**
 * Reasoning log: human-readable record of the agent's per-step reasoning text
 * and tool selections. Each step is written as a small block in the file. If
 * `consoleEcho` is true (driven by --verbose or config.verbose), the same
 * content is also emitted to stderr in a dimmed style so it never collides
 * with the AWS CLI output on stdout.
 *
 * Disable file output via `reasoning.enabled = false` in config; the file
 * writer becomes a no-op while console echo (if enabled) still works.
 */
export class ReasoningLogger {
  private readonly stream: fs.WriteStream | null;
  private readonly consoleEcho: boolean;
  private stepCounter = 0;

  constructor(opts: { enabled: boolean; consoleEcho: boolean }) {
    this.consoleEcho = opts.consoleEcho;
    if (!opts.enabled) {
      this.stream = null;
      return;
    }
    fs.mkdirSync(PATHS.state, { recursive: true });
    this.stream = fs.createWriteStream(FILES.reasoning, { flags: 'a' });
  }

  /** Mark the start of a new agent run with the user's input. */
  beginRun(input: string): void {
    const ts = new Date().toISOString();
    this.stepCounter = 0;
    const block =
      `\n========== run @ ${ts} ==========\n` +
      `input: ${input}\n`;
    this.writeFile(block);
    // Don't echo the run header to console — it's already visible from
    // the user's command line.
  }

  /** Record one agent step: reasoning text plus the tools it called. */
  logStep(args: {
    reasoning: string;
    toolCalls: Array<{ toolName: string; args: unknown }>;
    finishReason?: string;
  }): void {
    this.stepCounter += 1;
    const ts = new Date().toISOString();
    const lines: string[] = [];
    lines.push(`[${ts}] step ${this.stepCounter} (finish=${args.finishReason ?? 'n/a'})`);
    if (args.reasoning.trim().length > 0) {
      for (const l of args.reasoning.trim().split('\n')) {
        lines.push(`  reasoning: ${l}`);
      }
    }
    for (const call of args.toolCalls) {
      const argStr = safeStringify(call.args, 200);
      lines.push(`  tool_call: ${call.toolName}(${argStr})`);
    }
    const block = lines.join('\n') + '\n';
    this.writeFile(block);
    this.echoToConsole(args, this.stepCounter);
  }

  private writeFile(text: string): void {
    if (!this.stream) return;
    try {
      this.stream.write(text);
    } catch {
      // Same philosophy as audit: never crash the agent on log failure.
    }
  }

  private echoToConsole(
    args: { reasoning: string; toolCalls: Array<{ toolName: string; args: unknown }> },
    step: number,
  ): void {
    if (!this.consoleEcho) return;
    if (args.reasoning.trim().length > 0) {
      process.stderr.write(
        chalk.dim(`[reasoning step ${step}] `) + args.reasoning.trim() + '\n',
      );
    }
    for (const call of args.toolCalls) {
      const argStr = safeStringify(call.args, 120);
      process.stderr.write(
        chalk.dim(`[reasoning step ${step}] tool: ${call.toolName}(${argStr})\n`),
      );
    }
  }

  close(): void {
    this.stream?.end();
  }
}

function safeStringify(v: unknown, limit: number): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (s.length <= limit) return s;
  return s.slice(0, limit) + '…';
}
