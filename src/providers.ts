import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { LanguageModel } from 'ai';
import type { Config } from './config.js';

const DEFAULT_KEY_ENV = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
} as const;

/**
 * Build a LanguageModel from config.
 *
 * For anthropic / openai / google: API keys are read from environment
 * variables only — never from the config file — to keep secrets out of disk
 * state we don't own.
 *
 * For bedrock: no API key is needed. Authentication uses the standard AWS
 * credential chain (env vars, AWS_PROFILE, ~/.aws/credentials, SSO, IMDS,
 * container roles). Optionally `bedrockProfile` pins a specific named profile,
 * which is useful when the account hosting Bedrock model access is different
 * from the accounts the agent operates against.
 */
export function createModel(config: Config): LanguageModel {
  switch (config.provider) {
    case 'anthropic': {
      const apiKey = requireKey(config, 'anthropic');
      return createAnthropic({ apiKey })(config.model);
    }
    case 'openai': {
      const apiKey = requireKey(config, 'openai');
      return createOpenAI({ apiKey, compatibility: 'strict' })(config.model);
    }
    case 'google': {
      const apiKey = requireKey(config, 'google');
      return createGoogleGenerativeAI({ apiKey })(config.model);
    }
    case 'bedrock': {
      const region =
        config.bedrock?.region ??
        process.env.AWS_REGION ??
        process.env.AWS_DEFAULT_REGION;
      if (!region) {
        throw new Error(
          'Bedrock requires a region. Set "bedrock.region" in config or AWS_REGION env var.',
        );
      }
      const credentialProvider = config.bedrock?.profile
        ? fromNodeProviderChain({ profile: config.bedrock.profile })
        : fromNodeProviderChain();
      return createAmazonBedrock({ region, credentialProvider })(config.model);
    }
  }
}

function requireKey(
  config: Config,
  provider: keyof typeof DEFAULT_KEY_ENV,
): string {
  const envName = config.apiKeyEnv ?? DEFAULT_KEY_ENV[provider];
  const apiKey = process.env[envName];
  if (!apiKey) {
    throw new Error(
      `Missing API key. Set environment variable ${envName} (or override "apiKeyEnv" in config).`,
    );
  }
  return apiKey;
}
