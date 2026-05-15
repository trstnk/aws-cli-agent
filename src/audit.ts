import fs from 'node:fs';
import { FILES, PATHS } from './paths.js';

/**
 * Audit log: append-only JSONL of every command and script the agent ran on
 * the user's behalf. The audit log is intentionally exhaustive — it captures
 * the verbatim stdout/stderr so that, after the fact, you can reconstruct
 * exactly what the agent did and what AWS returned. For bash scripts the full
 * script source is included.
 *
 * Disable via `audit.enabled = false` in config; the writer becomes a no-op.
 */
export type AuditCommandEntry = {
  timestamp: string;
  type: 'aws_command';
  cmd: string;
  profile: string | null;
  exitCode: number;
  ok: boolean;
  stdout: string;
  stderr: string;
};

export type AuditScriptEntry = {
  timestamp: string;
  type: 'bash_script';
  cmd: string;
  profile: string | null;
  exitCode: number;
  ok: boolean;
  stdout: string;
  stderr: string;
  script: string;
};

export type AuditEntry = AuditCommandEntry | AuditScriptEntry;

export class AuditLogger {
  private readonly stream: fs.WriteStream | null;

  constructor(enabled: boolean) {
    if (!enabled) {
      this.stream = null;
      return;
    }
    fs.mkdirSync(PATHS.state, { recursive: true });
    this.stream = fs.createWriteStream(FILES.audit, { flags: 'a' });
  }

  logCommand(entry: Omit<AuditCommandEntry, 'timestamp' | 'type'>): void {
    this.write({ timestamp: new Date().toISOString(), type: 'aws_command', ...entry });
  }

  logScript(entry: Omit<AuditScriptEntry, 'timestamp' | 'type'>): void {
    this.write({ timestamp: new Date().toISOString(), type: 'bash_script', ...entry });
  }

  private write(entry: AuditEntry): void {
    if (!this.stream) return;
    try {
      this.stream.write(JSON.stringify(entry) + '\n');
    } catch {
      // Auditing must never crash the agent. Failures here are silent by
      // design; the operational logger will still surface execution errors.
    }
  }

  close(): void {
    this.stream?.end();
  }
}
