import fs from 'node:fs';
import { z } from 'zod';
import { FILES, PATHS } from './paths.js';

/**
 * Logging configuration. All keys are optional in the file; defaults tilt
 * toward "quiet but auditable" — a tool that writes to your AWS account
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
  .default({
    level: 'error',
    auditLog: true,
    reasoningLog: false,
    usageLog: true,
  });

/**
 * Per-provider configuration for the three keyed providers (Anthropic,
 * OpenAI, Google). Each block is optional in the file — but when the
 * top-level `provider` is set to one of these, the matching block must
 * exist AND contain a `model`. That validation runs in the post-parse
 * step (see `validateActiveProvider`).
 *
 * `apiKey` SECURITY NOTE: Putting the key here means it persists to disk.
 * Prefer the environment variable (default name, or override via
 * `apiKeyEnv`). The env var always wins if both are set.
 */
const KeyedProviderSchema = z
  .object({
    model: z.string().optional(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
  })
  .optional();

/**
 * Bedrock has a different shape: no apiKey (uses the AWS credential chain),
 * but adds region and profile. Like the keyed providers, this block is
 * optional in the file but required when `provider = "bedrock"`.
 */
const BedrockSchema = z
  .object({
    model: z.string().optional(),
    region: z.string().optional(),
    profile: z.string().optional(),
  })
  .optional();

export const ConfigSchema = z.object({
  /**
   * Which provider is active. The matching top-level block (anthropic /
   * openai / google / bedrock) must exist and contain a `model`. Use
   * `aca config` to see a working default scaffold.
   */
  provider: z
    .enum(['anthropic', 'openai', 'google', 'bedrock'])
    .default('anthropic'),

  // Per-provider blocks. Each is independently optional; the active
  // provider's block is validated separately for completeness.
  anthropic: KeyedProviderSchema,
  openai: KeyedProviderSchema,
  google: KeyedProviderSchema,
  bedrock: BedrockSchema,

  /**
   * Default AWS region for AWS CLI commands the agent executes. Used when
   * the user didn't mention a region in the request and history didn't
   * supply one. Overridable per-run with --region. Independent of
   * `bedrock.region` (which is for Bedrock API calls, not AWS CLI calls).
   */
  defaultRegion: z.string().optional(),

  /** Max reasoning/tool-use steps before the agent must conclude. */
  maxSteps: z.number().int().min(1).max(50).default(15),

  /** All logging knobs. */
  logging: LoggingSchema,

  /**
   * Prompt caching. When true, the cacheable prefix is marked so providers
   * that support it can cache hits cheaply (~10% of normal input tokens
   * on Anthropic and Bedrock-via-Anthropic). OpenAI auto-caches large
   * prompts and ignores this flag. Google Gemini's caching API isn't
   * wired up yet; this flag is silently ignored for that provider.
   */
  caching: z.boolean().default(true),

  /**
   * Echo reasoning to stderr in real time. Independent of
   * `logging.reasoningLog`. Override per-run with --verbose.
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
    .default({ readOnly: true, all: false }),

  /**
   * Force every AWS CLI command into interactive (TTY) mode. Almost always
   * leave this unset and use the --interactive / -i CLI flag instead.
   */
  forceInteractive: z.boolean().default(false),

  /** Max history entries kept in memory. */
  historyLimit: z.number().int().min(0).default(200),

  /**
   * Directory where generated bash scripts are saved when the user picks
   * "Save to disk" at the prompt. Defaults to
   * $XDG_DATA_HOME/aws-cli-agent/scripts.
   */
  scriptFolder: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Map of provider → label used in error messages and the migration hint.
 * Kept here (not in providers.ts) so config-load errors don't depend on
 * the provider module.
 */
const PROVIDER_LABELS = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  bedrock: 'bedrock',
} as const;

/**
 * Resolve the active provider's model. The schema marks `model` optional
 * per-block so that we can produce a single coherent error message in
 * `validateActiveProvider` rather than zod's multi-issue tree. Call this
 * only after validateActiveProvider has passed.
 */
export function getActiveModel(config: Config): string {
  const block = config[config.provider];
  // model is guaranteed by validateActiveProvider.
  return block!.model!;
}

/**
 * Strict post-parse validation for the active provider's block. The active
 * provider's block must exist and must contain a `model`. Pre-1.0 we treat
 * this as a hard error rather than scaffolding defaults, so the user always
 * knows exactly what's being called and at what cost.
 *
 * Call this from code paths that actually run the agent — the `run` command.
 * Subcommands that don't need a provider (`paths`, `config`, `history`)
 * skip this check, so a user with no config file can still use them.
 */
export function validateActiveProvider(config: Config): void {
  const active = config.provider;
  const block = config[active];
  if (!block) {
    throw new Error(
      `config.provider is "${active}" but no top-level "${PROVIDER_LABELS[active]}" ` +
        `block was found. At minimum add: ` +
        `{ "${active}": { "model": "<model-id>" } }. Run \`aca config\` to see a ` +
        `working default scaffold.`,
    );
  }
  if (!block.model) {
    throw new Error(
      `config.${active}.model is required. Set it to the model identifier you ` +
        `want to use (e.g. "claude-sonnet-4-6" for anthropic).`,
    );
  }
}

/**
 * Detect the pre-0.6 config shape and produce a helpful migration error
 * rather than the cryptic "Required" zod failures the user would otherwise
 * get. Heuristic: a top-level `model` or top-level `apiKeyEnv` is a strong
 * signal of an old config, since neither key exists in the new schema.
 */
function detectLegacyShape(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return;
  const obj = raw as Record<string, unknown>;
  if ('model' in obj || 'apiKeyEnv' in obj) {
    throw new Error(
      `Config file uses the pre-0.6.0 shape (top-level "model" / "apiKeyEnv" / ` +
        `flat "bedrock" block). The new shape moves these into per-provider blocks:\n` +
        `\n` +
        `  Old:                              New:\n` +
        `    "provider": "anthropic",          "provider": "anthropic",\n` +
        `    "model": "claude-...",            "anthropic": {\n` +
        `    "apiKeyEnv": "MY_KEY"               "model": "claude-...",\n` +
        `                                        "apiKeyEnv": "MY_KEY"\n` +
        `                                      }\n` +
        `\n` +
        `For bedrock, move the existing "region"/"profile" alongside a new\n` +
        `"model" field, all under the "bedrock" block.\n` +
        `\n` +
        `To start fresh: rename your old config, run \`aca config\`, then copy values across.`,
    );
  }
}

export function loadConfig(): Config {
  if (!fs.existsSync(FILES.config)) {
    // No file = pure defaults. Strict validation is deferred to callers
    // who actually need the provider (the `run` command), so subcommands
    // like `paths`, `config`, `history` work without a config file.
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
      { cause: err },
    );
  }
  detectLegacyShape(raw);
  return ConfigSchema.parse(raw);
}

/**
 * Write a default config file if none exists. Scaffolds only the active
 * provider's block (just `model`), deliberately not creating slots for
 * other providers (less to read) and not scaffolding `apiKey` (less
 * temptation to put secrets on disk).
 *
 * Sets mode 0600 on the file. This doesn't protect against a user editing
 * with `cp` or moving the file later, but ensures that the file as we
 * create it isn't world-readable.
 */
export function writeDefaultConfig(): string {
  fs.mkdirSync(PATHS.config, { recursive: true });
  if (!fs.existsSync(FILES.config)) {
    const defaults = {
      provider: 'anthropic' as const,
      anthropic: { model: 'claude-sonnet-4-6' },
      maxSteps: 15,
      logging: {
        level: 'error' as const,
        auditLog: true,
        reasoningLog: false,
        usageLog: true,
      },
      caching: true,
      verbose: false,
      autoApprove: { readOnly: true, all: false },
      forceInteractive: false,
      historyLimit: 200,
    };
    fs.writeFileSync(FILES.config, JSON.stringify(defaults, null, 2) + '\n', {
      mode: 0o600,
    });
  }
  return FILES.config;
}
