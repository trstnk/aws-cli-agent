import fs from 'node:fs';
import chalk from 'chalk';
import { FILES, PATHS } from './paths.js';

/**
 * Reasoning log: human-readable record of the agent's per-step reasoning text
 * and tool selections.
 *
 * Design note: in v0.3.0 we switched the agent loop from `generateText` to
 * `streamText` so that reasoning text chunks arrive in stream order, BEFORE
 * the model finalizes its tool call. The streaming loop in agent.ts is now
 * the orchestrator: it decides when to print reasoning (after each step's
 * text-end event, before the tool-call event). This class is a dumb printer
 * — no state buffering, no step counter — so the streaming loop has clean
 * control over ordering.
 *
 * The file log (reasoning.log) is written separately at the end of each
 * step with the full text + tool calls in one block.
 */
export class ReasoningLogger {
  private readonly stream: fs.WriteStream | null;
  private readonly consoleEcho: boolean;

  constructor(opts: { enabled: boolean; consoleEcho: boolean }) {
    this.consoleEcho = opts.consoleEcho;
    if (!opts.enabled) {
      this.stream = null;
      return;
    }
    fs.mkdirSync(PATHS.state, { recursive: true });
    this.stream = fs.createWriteStream(FILES.reasoning, { flags: 'a' });
  }

  /** Whether the agent should call the echo* methods at all. Lets the
   * streaming loop skip work when verbose is off. */
  get echoEnabled(): boolean {
    return this.consoleEcho;
  }

  /** Mark the start of a new agent run with the user's input. */
  beginRun(input: string): void {
    const ts = new Date().toISOString();
    const block =
      `\n========== run @ ${ts} ==========\n` +
      `input: ${input}\n`;
    this.writeFile(block);
    // Don't echo the run header to console — already visible from the prompt.
  }

  /**
   * Echo a step's reasoning text to the console. Called by the streaming
   * loop AFTER the model's text stream ends for that step, BEFORE the
   * tool-call event for that same step. The reasoning therefore appears
   * above its associated tool call line — and above any approval prompt
   * the tool's execute() might display.
   */
  echoReasoning(step: number, text: string): void {
    if (!this.consoleEcho) return;
    if (text.trim().length === 0) return;
    process.stderr.write(chalk.dim(`[${pad2(step)}] `) + text.trim() + '\n');
  }

  /**
   * Echo a step's tool call line to the console. Called by the streaming
   * loop on the tool-call event, AFTER any reasoning for that step has
   * been echoed, BEFORE the SDK invokes the tool's execute() function.
   */
  echoToolCall(step: number, toolName: string, toolInput: unknown): void {
    if (!this.consoleEcho) return;
    const argStr = safeStringify(toolInput, 120);
    process.stderr.write(
      chalk.dim(`[${pad2(step)}] `) + `tool: ${toolName}(${argStr})\n`,
    );
  }

  /**
   * Append a completed step to the reasoning file. Called by the streaming
   * loop on the finish-step event. Ordering doesn't matter for the file —
   * it's append-only and read post-hoc — so we batch the whole step's
   * data into one block here.
   */
  logStepToFile(args: {
    step: number;
    reasoning: string;
    toolCalls: Array<{ toolName: string; args: unknown }>;
    finishReason?: string;
  }): void {
    const ts = new Date().toISOString();
    const lines: string[] = [];
    lines.push(`[${ts}] step ${pad2(args.step)} (finish=${args.finishReason ?? 'n/a'})`);
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
  }

  private writeFile(text: string): void {
    if (!this.stream) return;
    try {
      this.stream.write(text);
    } catch {
      // Same philosophy as audit: never crash the agent on log failure.
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

/**
 * Format an integer as a 2-digit zero-padded string. Used so step labels
 * line up visually: "step 01" through "step 09" align with "step 10" and
 * beyond. For numbers ≥ 100 the value is emitted as-is (we don't truncate),
 * so a runaway 150-step run is still readable, just unaligned.
 */
function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}
