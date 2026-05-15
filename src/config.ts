import fs from 'node:fs';
import { z } from 'zod';
import { FILES, PATHS } from './paths.js';

/**
 * Logging configuration. All three keys are optional in the file; defaults
 * tilt toward "quiet but auditable" — a tool that writes to your AWS account
 * should leave a paper trail by default, but shouldn't be noisy on the
 * console unless you ask.
 */
const LoggingSchema = z
  .object({
    level: z
      .enum(['silent', 'error', 'warn', 'info', 'debug', 'trace'])
      .default('error'),
    auditLog: z.boolean().default(true),
    reasoningLog: z.boolean().default(false),
    usageLog: z.boolean().default(true),
  })
  .default({});

/**
 * Bedrock-specific configuration. Only meaningful when `provider = bedrock`;
 * both keys are optional within that.
 */
const BedrockSchema = z
  .object({
    region: z.string().optional(),
    profile: z.string().optional(),
  })
  .optional();

export const ConfigSchema = z.object({
  /** Which remote AI provider to call. */
  provider: z
    .enum(['anthropic', 'openai', 'google', 'bedrock'])
    .default('anthropic'),
  /** Model identifier passed to the provider. */
  model: z.string().default('claude-sonnet-4-5-20250929'),
  /**
   * Optional override for the env var name that holds the API key.
   * Ignored when provider = "bedrock" (Bedrock uses the AWS credential chain).
   */
  apiKeyEnv: z.string().optional(),
  /**
   * Bedrock provider settings (region + profile). Only used when
   * provider = "bedrock". See providers.ts for fallback chain.
   */
  bedrock: BedrockSchema,
  /**
   * Default AWS region for AWS CLI commands the agent executes. Used when the
   * user didn't mention a region in the request and history didn't supply one.
   * Overridable per-run with --region. Independent of `bedrock.region`.
   */
  defaultRegion: z.string().optional(),
  /** Max reasoning/tool-use steps before the agent must conclude. */
  maxSteps: z.number().int().min(1).max(50).default(15),
  /** All logging knobs live here — see LoggingSchema for details. */
  logging: LoggingSchema,
  /**
   * Prompt caching. When true, the system prompt + tool definitions (the
   * long-lived prefix sent on every step) are marked cacheable for providers
   * that support it. Cache hits cost ~10% of normal input tokens (Anthropic
   * direct and Bedrock-via-Anthropic). OpenAI auto-caches large prompts and
   * ignores this flag. Google Gemini's caching API isn't supported yet —
   * this flag is silently ignored for that provider. Default true: most
   * users invoke `aca` more than once every 5 minutes, so the cache pays
   * for itself quickly; users running it rarely can disable it to avoid
   * the small cache-write premium on each first call.
   */
  caching: z.boolean().default(true),
  /**
   * When true, reasoning steps are echoed to stderr in real time. Independent
   * of `logging.reasoningLog`: you can have file logging on and console echo
   * off, or vice versa. Overridable per-run with --verbose.
   */
  verbose: z.boolean().default(false),
  /** Auto-approval policy for command/script execution. */
  autoApprove: z
    .object({
      /** Auto-approve read-only AWS commands (describe-*, list-*, get-*, s3 ls). */
      readOnly: z.boolean().default(true),
      /** Auto-approve every command and script. Dangerous. */
      all: z.boolean().default(false),
    })
    .default({}),
  /**
   * When true, every AWS CLI command runs in interactive mode (stdio inherited
   * from the parent terminal). This is the persistent equivalent of the
   * `--interactive` / `-i` CLI flag — useful in rare edge cases where the
   * pattern-based auto-detection misses a command that needs a TTY. Almost
   * always you want to leave this unset and rely on either the CLI flag for
   * one-off invocations or the per-tool-call override the agent can set.
   */
  forceInteractive: z.boolean().default(false),
  /** Maximum number of history entries kept in memory. */
  historyLimit: z.number().int().min(0).default(200),
  /**
   * Directory where the user may save generated bash scripts (offered as an
   * alternative to executing them inline). Defaults to
   * $XDG_DATA_HOME/aws-cli-agent/scripts.
   */
  scriptFolder: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  if (!fs.existsSync(FILES.config)) {
    return ConfigSchema.parse({});
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(FILES.config, 'utf8'));
  } catch (err) {
    throw new Error(
      `Config file at ${FILES.config} is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return ConfigSchema.parse(raw);
}

/** Write a default config file if none exists. Returns the path either way. */
export function writeDefaultConfig(): string {
  fs.mkdirSync(PATHS.config, { recursive: true });
  if (!fs.existsSync(FILES.config)) {
    const defaults = ConfigSchema.parse({});
    fs.writeFileSync(FILES.config, JSON.stringify(defaults, null, 2) + '\n');
  }
  return FILES.config;
}
