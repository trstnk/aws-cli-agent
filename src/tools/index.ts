import { awsCliTool } from './aws-cli.js';
import { bashScriptTool } from './bash.js';
import { listProfilesTool } from './profiles.js';
import { historyTool } from './history.js';
import { promptUserTool, promptUserMultiTool } from './prompt.js';
import type { Logger } from '../logger.js';
import type { Config } from '../config.js';
import type { History } from '../history.js';
import type { AuditLogger } from '../audit.js';

export type ExecutionRecord = {
  cmd: string;
  profile: string | null;
  stdout: string;
  stderr: string;
  exitCode: number;
  ok: boolean;
};

export type ToolContext = {
  logger: Logger;
  config: Config;
  history: History;
  audit: AuditLogger;
  record: (entry: ExecutionRecord) => void;
};

export function createTools(ctx: ToolContext) {
  return {
    query_history: historyTool({ history: ctx.history, logger: ctx.logger }),
    list_aws_profiles: listProfilesTool({ logger: ctx.logger }),
    prompt_user: promptUserTool({ logger: ctx.logger }),
    prompt_user_multi: promptUserMultiTool({ logger: ctx.logger }),
    execute_aws_command: awsCliTool({
      logger: ctx.logger,
      config: ctx.config,
      audit: ctx.audit,
      record: ctx.record,
    }),
    execute_bash_script: bashScriptTool({
      logger: ctx.logger,
      config: ctx.config,
      audit: ctx.audit,
      record: ctx.record,
    }),
  };
}
