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

/**
 * Build the agent's tool set.
 *
 * Note on caching: there is no per-tool cache marker here. We previously
 * marked the last tool with `providerOptions.{anthropic.cacheControl,
 * bedrock.cachePoint}` hoping the SDK would translate that into a cache
 * breakpoint after the tools section of the request body. Investigation of
 * `@ai-sdk/amazon-bedrock` v4 showed it only reads `name`, `description`,
 * `strict`, and `inputSchema` when serializing function tools — it ignores
 * `providerOptions`, so the marker had no effect. Confirmed via trace logs:
 * `cacheDetails` always had one entry (the system message), never two.
 *
 * So the prompt cache currently captures only the system message. The
 * tools array is re-sent at full cost on every request. If/when the SDK
 * starts propagating tool-level providerOptions to cachePoints, the right
 * place to add markers is on the last entry in this object — Anthropic
 * recommends a single breakpoint at the end of the tools block.
 */
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
