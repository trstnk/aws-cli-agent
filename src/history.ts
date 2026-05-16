import fs from 'node:fs';
import readline from 'node:readline';
import { FILES, PATHS } from './paths.js';

export type HistoryEntry = {
  timestamp: string;
  input: string;
  commands: string[];
  profile: string | null;
  /**
   * Resources is currently not used.
   * Intention: Capture the named resources the agent worked with on each run, keyed by type.
   * So a history entry for "list buckets in btc-cloud-sandbox" might end up as:
   * json{
   *   "input": "list buckets in my-account",
   *   "commands": ["aws s3 ls --profile my-account"],
   *   "profile": "my-account",
   *   "resources": {
   *     "account": "my-account"
   *   }
   * }
   */
  resources: Record<string, string>;
  success: boolean;
};

export class History {
  private entries: HistoryEntry[] = [];
  private readonly limit: number;

  constructor(limit = 200) {
    this.limit = limit;
  }

  async load(): Promise<void> {
    if (!fs.existsSync(FILES.history)) return;
    const lines: HistoryEntry[] = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(FILES.history),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        lines.push(JSON.parse(trimmed) as HistoryEntry);
      } catch {
        // ignore malformed lines so a corrupt entry doesn't break everything
      }
    }
    this.entries = lines.slice(-this.limit);
  }

  append(entry: HistoryEntry): void {
    fs.mkdirSync(PATHS.state, { recursive: true });
    fs.appendFileSync(FILES.history, JSON.stringify(entry) + '\n');
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries = this.entries.slice(-this.limit);
    }
  }

  /**
   * Simple token-overlap search across input, commands, profile, and resources.
   * Returns highest-scoring entries first, newest as tiebreak.
   */
  search(query: string, limit = 10): HistoryEntry[] {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return this.recent(limit);

    const scored = this.entries.map((e, idx) => {
      const hay = [
        e.input,
        ...e.commands,
        e.profile ?? '',
        ...Object.values(e.resources),
      ]
        .join(' ')
        .toLowerCase();
      let score = 0;
      for (const t of tokens) if (hay.includes(t)) score += 1;
      return { entry: e, score, idx };
    });

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.idx - a.idx)
      .slice(0, limit)
      .map((s) => s.entry);
  }

  recent(limit = 10): HistoryEntry[] {
    return this.entries.slice(-limit).reverse();
  }
}
