import fs from 'node:fs';
import { FILES, PATHS } from './paths.js';

/**
 * Usage log: append-only JSONL of token totals per `aca` invocation. One line
 * per run. Totals only — per-step breakdown is intentionally omitted to keep
 * entries small and forward-compatible across providers.
 *
 * Disable via `logging.usageLog = false` in config; the writer becomes a no-op.
 *
 * Analytical use: this file is grep/jq-friendly. Sum tokens for the day:
 *   cat ~/.local/state/aws-cli-agent/usage.log | jq -s 'map(.totalTokens) | add'
 */
export type UsageEntry = {
  timestamp: string;
  input: string;
  provider: string;
  model: string;
  steps: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /**
   * Tokens served from prompt cache (cache hit). Available on Anthropic and
   * Bedrock when caching was enabled and the provider returned the count.
   * 0 when caching was disabled, the provider didn't report it, or this
   * was a first-time request with no cache to hit.
   */
  cacheReadTokens: number;
  /**
   * Tokens written to prompt cache (cache miss + store). Counts the prefix
   * length on cache-write events. 0 when caching was disabled or the
   * provider didn't write a cache entry on this call.
   */
  cacheWriteTokens: number;
};

export class UsageLogger {
  private readonly stream: fs.WriteStream | null;

  constructor(enabled: boolean) {
    if (!enabled) {
      this.stream = null;
      return;
    }
    fs.mkdirSync(PATHS.state, { recursive: true });
    this.stream = fs.createWriteStream(FILES.usage, { flags: 'a' });
  }

  log(entry: Omit<UsageEntry, 'timestamp'>): void {
    if (!this.stream) return;
    try {
      const full: UsageEntry = { timestamp: new Date().toISOString(), ...entry };
      this.stream.write(JSON.stringify(full) + '\n');
    } catch {
      // Same philosophy as the other loggers: never crash the agent on
      // log failures. Usage tracking is observability, not load-bearing.
    }
  }

  close(): void {
    this.stream?.end();
  }
}
