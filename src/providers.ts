import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { LanguageModel } from 'ai';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

/**
 * Map provider → default env-var name. Used as the second fallback in the
 * resolution chain (see `requireKey`).
 */
const DEFAULT_KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
} as const;

/**
 * Build a LanguageModel from config.
 *
 * Per-provider config lives under the matching top-level block:
 *   config.anthropic.{model, apiKey, apiKeyEnv}
 *   config.openai.{model, apiKey, apiKeyEnv}
 *   config.google.{model, apiKey, apiKeyEnv}
 *   config.bedrock.{model, region, profile}
 *
 * For anthropic / openai / google, API key resolution order (per-provider):
 *   1. Env var named by `<provider>.apiKeyEnv` if set in config
 *   2. Default env var for the provider (ANTHROPIC_API_KEY etc.)
 *   3. `<provider>.apiKey` from config (last resort — persists to disk)
 *   4. Throw with all options listed
 *
 * For bedrock: no API key. The AWS credential chain (env vars, AWS_PROFILE,
 * ~/.aws/credentials, SSO, IMDS, container roles) is used. `bedrock.profile`
 * optionally pins a specific named profile — useful when the account hosting
 * Bedrock model access is different from the accounts the agent operates
 * against.
 *
 * The `logger` parameter is used to emit a debug-level note when the key
 * resolves from config instead of env, so an investigator can see "this run
 * read the key from disk" in general.log. The key itself is never logged.
 */
export function createModel(config: Config, logger?: Logger): LanguageModel {
  switch (config.provider) {
    case 'anthropic': {
      const block = config.anthropic!; // validated upstream
      const apiKey = requireKey('anthropic', block.apiKey, block.apiKeyEnv, logger);
      return createAnthropic({ apiKey })(block.model!);
    }
    case 'openai': {
      const block = config.openai!;
      const apiKey = requireKey('openai', block.apiKey, block.apiKeyEnv, logger);
      return createOpenAI({ apiKey })(block.model!);
    }
    case 'google': {
      const block = config.google!;
      const apiKey = requireKey('google', block.apiKey, block.apiKeyEnv, logger);
      return createGoogleGenerativeAI({ apiKey })(block.model!);
    }
    case 'bedrock': {
      const block = config.bedrock!;
      const region =
        block.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      if (!region) {
        throw new Error(
          'Bedrock requires a region. Set "bedrock.region" in config or AWS_REGION env var.',
        );
      }
      const credentialProvider = block.profile
        ? fromNodeProviderChain({ profile: block.profile })
        : fromNodeProviderChain();
      return createAmazonBedrock({ region, credentialProvider })(block.model!);
    }
  }
}

/**
 * Three-tier API key resolution. Returns the key (never logs it). Emits a
 * debug-level note when the key came from config rather than env, so an
 * investigator looking at general.log can see what happened.
 *
 * When `apiKeyEnv` is set in config but the named env var is empty, we emit
 * a warning to stderr and fall through to the default env var. The warning
 * matters because `apiKeyEnv` is an explicit user instruction ("read the
 * key from THIS variable") — silently using a different source could send
 * the wrong account's request to the model provider.
 */
function requireKey(
  provider: keyof typeof DEFAULT_KEY_ENV,
  configKey: string | undefined,
  configKeyEnv: string | undefined,
  logger: Logger | undefined,
): string {
  // 1. Custom env var name from config takes precedence — when it's set.
  if (configKeyEnv) {
    const v = process.env[configKeyEnv];
    if (v) return v;
    // The user told us where to look, but the variable is empty. This is
    // almost always a mistake (typo'd var name, forgot to export it,
    // wrong shell). Surface it loudly so they fix it; then fall through
    // to the default env var so the run can still succeed if that's set.
    process.stderr.write(
      `Warning: config.${provider}.apiKeyEnv names "${configKeyEnv}" but ` +
        `that environment variable is not set. Falling back to the default ` +
        `(${DEFAULT_KEY_ENV[provider]}) or config.${provider}.apiKey.\n`,
    );
    logger?.warn(
      `${provider}: configured apiKeyEnv "${configKeyEnv}" is not set in the environment.`,
    );
  }
  // 2. Default env var for the provider.
  const defaultEnv = DEFAULT_KEY_ENV[provider];
  const fromDefaultEnv = process.env[defaultEnv];
  if (fromDefaultEnv) return fromDefaultEnv;
  // 3. Config-stored key — last resort. Note it.
  if (configKey) {
    logger?.debug(
      `${provider}: API key loaded from config file (no env var set). ` +
        `Prefer ${configKeyEnv ?? defaultEnv} env var for production use.`,
    );
    return configKey;
  }
  // 4. Nothing.
  throw new Error(
    `No API key found for provider "${provider}". Set one of:\n` +
      (configKeyEnv
        ? `  - env var ${configKeyEnv} (named by config.${provider}.apiKeyEnv)\n`
        : '') +
      `  - env var ${defaultEnv} (default for ${provider})\n` +
      `  - config.${provider}.apiKey (persists to disk — env var preferred)`,
  );
}
