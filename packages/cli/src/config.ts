/**
 * CLI configuration — environment-driven provider selection.
 */

export type ProviderKind = "mock" | "openai-compatible";

export interface Config {
  provider: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  cwd: string;
}

const DEFAULT_MODEL = "gpt-4o-mini";

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

/**
 * Builds the CLI configuration from a process environment.
 * Keys: ELYSIUM_PROVIDER ('mock' | 'openai-compatible', default 'mock'),
 * ELYSIUM_BASE_URL, ELYSIUM_API_KEY, ELYSIUM_MODEL (default 'gpt-4o-mini').
 * The working directory is the current process working directory.
 * Throws on an unknown ELYSIUM_PROVIDER value.
 */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const rawProvider = readEnv(env, "ELYSIUM_PROVIDER");
  let provider: ProviderKind = "mock";
  if (rawProvider !== undefined) {
    const value = rawProvider.toLowerCase();
    if (value !== "mock" && value !== "openai-compatible") {
      throw new Error(
        `ELYSIUM_PROVIDER must be 'mock' or 'openai-compatible', got '${rawProvider}'`,
      );
    }
    provider = value;
  }

  const model = readEnv(env, "ELYSIUM_MODEL") ?? DEFAULT_MODEL;
  const config: Config = { provider, model, cwd: process.cwd() };
  const baseUrl = readEnv(env, "ELYSIUM_BASE_URL");
  if (baseUrl !== undefined) {
    config.baseUrl = baseUrl;
  }
  const apiKey = readEnv(env, "ELYSIUM_API_KEY");
  if (apiKey !== undefined) {
    config.apiKey = apiKey;
  }
  return config;
}
