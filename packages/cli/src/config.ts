/**
 * Provider configuration — reads from env vars or .env file.
 * No external dependencies (no dotenv).
 */
import fs from "node:fs";
import path from "node:path";

export interface ProviderConfig {
  provider: "openai" | "deepseek" | "groq" | "together" | "openrouter" | "ollama" | "mock";
  baseUrl: string;
  apiKey: string;
  model: string;
}

const PROVIDER_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
};

const PROVIDER_MODELS: Record<string, string> = {
  openai: "gpt-4o-mini",
  deepseek: "deepseek-chat",
  groq: "llama-3.3-70b-versatile",
  together: "meta-llama/Llama-3-70b-chat-hf",
  openrouter: "anthropic/claude-sonnet-4",
  ollama: "qwen2.5:14b",
  mock: "mock",
};

/** Load .env file (simple KEY=VALUE parser, no quotes handling needed). */
function loadEnvFile(dir: string): Record<string, string> {
  const envPath = path.join(dir, ".env");
  const result: Record<string, string> = {};
  if (!fs.existsSync(envPath)) return result;
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    result[key] = value;
  }
  return result;
}

/** Load config from env vars, falling back to .env file in cwd or project root. */
export function loadConfig(projectRoot?: string): ProviderConfig {
  const root = projectRoot ?? process.cwd();
  const fileEnv = loadEnvFile(root);
  const get = (key: string): string =>
    process.env[key] ?? fileEnv[key] ?? "";

  const provider = (get("ELYSIUM_PROVIDER") || "mock").toLowerCase();
  const apiKey = get("ELYSIUM_API_KEY");
  const model = get("ELYSIUM_MODEL") || PROVIDER_MODELS[provider] || "gpt-4o-mini";
  const baseUrl = get("ELYSIUM_BASE_URL") || PROVIDER_URLS[provider] || "";

  // If no API key and not mock/ollama, warn but don't crash — the user can add one later.
  return { provider: provider as ProviderConfig["provider"], baseUrl, apiKey, model };
}

/** Return a human-readable description of the current config. */
export function describeConfig(config: ProviderConfig): string {
  if (config.provider === "mock") return "MockProvider (deterministic, offline)";
  const masked = config.apiKey
    ? config.apiKey.slice(0, 8) + "***" + config.apiKey.slice(-4)
    : "(no key)";
  return `${config.provider} | ${config.model} | key: ${masked} | url: ${config.baseUrl}`;
}
