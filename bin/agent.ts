#!/usr/bin/env node
/**
 * Elysium Harness — AI Agent CLI
 *
 *   pnpm agent                     Interactive REPL
 *   pnpm agent "do something"      Single task
 *   pnpm agent --help              Show help
 *
 * Slash commands in REPL:
 *   /model [name]       Show or switch model
 *   /connections        Show configured providers
 *   /key <provider> <key>  Set API key for a provider
 *   /tools              List available tools
 *   /workspace          Show workspace path
 *   /clear              Clear screen
 *   /help               Show help
 *   /quit               Exit
 *
 * Configure providers in .env (see .env.example).
 */
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import {
  Agent,
  MockProvider,
  OpenAICompatibleProvider,
  ToolRegistry,
  createBuiltinTools,
  type Tool,
  type ToolResultMessage,
  type ToolCallPart,
} from "@elysium/core";
import {
  loadConfig,
  saveEnvValue,
  describeConfig,
  PROVIDER_NAMES,
  PROVIDER_MODELS,
  PROVIDER_URLS,
  type ProviderConfig,
  type ProviderName,
} from "../packages/cli/src/config";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const WORKSPACE = fs.mkdtempSync(path.join(
  process.env.TEMP || process.env.TMP || "/tmp",
  "elysium-",
));

const SYSTEM_PROMPT =
  "You are Elysium, an AI coding agent. You have access to tools for reading, writing, editing files, and executing commands. Use them when needed. Be concise and direct. Always explain what you did.";

// ── Provider factory ──────────────────────────────────────────────

function createProvider(config: ProviderConfig) {
  if (config.provider === "mock") {
    return new MockProvider([
      { text: "I am running in mock mode (offline). Configure a real provider with /key or .env file." },
    ]);
  }
  if (!config.apiKey && config.provider !== "ollama") {
    console.error(`\n  ⚠  No API key for ${PROVIDER_NAMES[config.provider] ?? config.provider}.`);
    console.error(`  Use: /key ${config.provider} <your-api-key>\n`);
    process.exit(1);
  }
  return new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey || "ollama",
    model: config.model,
  });
}

// ── Tool wiring ───────────────────────────────────────────────────

function createToolRegistry(): ToolRegistry {
  const policy = { allowedRoots: [WORKSPACE, process.cwd()] };
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools(policy)) registry.register(tool);
  return registry;
}

function wireAgent(config: ProviderConfig, registry: ToolRegistry): Agent {
  const provider = createProvider(config);
  return new Agent({
    systemPrompt: SYSTEM_PROMPT,
    provider,
    tools: registry.list(),
    maxTurns: 8,
    executeTool: async (call: ToolCallPart, ctx: { signal: AbortSignal }): Promise<ToolResultMessage> => {
      const tool = registry.get(call.name);
      if (!tool) {
        return { role: "tool_result", toolCallId: call.id, toolName: call.name, content: `unknown tool: ${call.name}`, isError: true };
      }
      try {
        const result = await tool.execute(call.arguments, {
          cwd: WORKSPACE,
          signal: ctx.signal,
          emit: () => undefined,
        });
        return {
          role: "tool_result", toolCallId: call.id, toolName: call.name,
          content: result.content, isError: result.isError,
          ...(result.details !== undefined ? { details: result.details } : {}),
        };
      } catch (err: unknown) {
        return { role: "tool_result", toolCallId: call.id, toolName: call.name,
          content: `error: ${err instanceof Error ? err.message : String(err)}`, isError: true };
      }
    },
  });
}

// ── Args ──────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { task: string | null; provider: string | null; help: boolean } {
  let task: string | null = null;
  let provider: string | null = null;
  let help = false;
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--help" || args[i] === "-h") help = true;
    else if (args[i] === "--task" && args[i + 1]) task = args[++i] ?? null;
    else if (args[i] === "--provider" && args[i + 1]) provider = args[++i] ?? null;
    else if (!args[i]!.startsWith("-")) task = args[i];
  }
  return { task, provider, help };
}

// ── REPL ──────────────────────────────────────────────────────────

async function runRepl(config: ProviderConfig): Promise<void> {
  const registry = createToolRegistry();
  let agent = wireAgent(config, registry);

  console.log(`
  ╔══════════════════════════════════════════╗
  ║        ⚡  Elysium Harness  ⚡           ║
  ║        AI Agent with Tool Use            ║
  ╚══════════════════════════════════════════╝
`);
  console.log(`  Provider: ${describeConfig(config)}`);
  console.log(`  Workspace: ${WORKSPACE}`);
  console.log(`  Type /help for commands.\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "⚡ > " });
  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Slash commands ──
    if (input === "/quit" || input === "/exit") {
      console.log("\n  👋 Goodbye.\n"); process.exit(0);
    }
    if (input === "/clear") { console.clear(); rl.prompt(); return; }
    if (input === "/help") {
      console.log(`
  Commands:
    /model                  Show current provider and model
    /model <provider>       Switch provider (openai, deepseek, groq, glm, opencode, ollama, mock)
    /model <provider> <m>   Switch provider and model
    /connections            List all configured providers and their status
    /key <provider> <key>   Set API key (saved to .env)
    /tools                  List available tools
    /workspace              Show workspace path
    /clear                  Clear screen
    /help                   This help
    /quit                   Exit
`); rl.prompt(); return;
    }
    if (input === "/model") {
      console.log(`\n  Current: ${describeConfig(config)}\n`);
      console.log(`  Available providers:`);
      for (const [k, v] of Object.entries(PROVIDER_NAMES)) {
        const current = k === config.provider ? " ← active" : "";
        console.log(`    ${k.padEnd(12)} ${v}${current}`);
      }
      console.log();
      rl.prompt(); return;
    }
    if (input.startsWith("/model ")) {
      const parts = input.slice(7).trim().split(/\s+/);
      const newProvider = parts[0] as ProviderName;
      const newModel = parts[1] || PROVIDER_MODELS[newProvider] || "";
      if (!PROVIDER_URLS[newProvider]) {
        console.log(`\n  ✗ Unknown provider: ${newProvider}\n`);
        rl.prompt(); return;
      }
      const oldProvider = config.provider;
      config = { ...config, provider: newProvider, baseUrl: PROVIDER_URLS[newProvider], model: newModel || PROVIDER_MODELS[newProvider] };
      saveEnvValue(PROJECT_ROOT, "ELYSIUM_PROVIDER", newProvider);
      if (newModel) saveEnvValue(PROJECT_ROOT, "ELYSIUM_MODEL", newModel);
      saveEnvValue(PROJECT_ROOT, "ELYSIUM_BASE_URL", "");
      // Rebuild agent with new provider
      try {
        agent = wireAgent(config, registry);
        console.log(`\n  ✓ Switched to ${PROVIDER_NAMES[newProvider] ?? newProvider} | ${config.model}\n`);
      } catch (err: unknown) {
        console.log(`\n  ✗ ${err instanceof Error ? err.message : String(err)}\n`);
        config = { ...config, provider: oldProvider };
      }
      rl.prompt(); return;
    }
    if (input.startsWith("/key ")) {
      const parts = input.slice(5).trim().split(/\s+/);
      if (parts.length < 2) { console.log(`\n  Usage: /key <provider> <api-key>\n`); rl.prompt(); return; }
      const [prov, ...keyParts] = parts;
      const key = keyParts.join(" ");
      if (!PROVIDER_URLS[prov!]) {
        console.log(`\n  ✗ Unknown provider: ${prov}. Use: /key <openai|deepseek|groq|glm|opencode|openrouter> <key>\n`);
        rl.prompt(); return;
      }
      saveEnvValue(PROJECT_ROOT, "ELYSIUM_API_KEY", key);
      saveEnvValue(PROJECT_ROOT, "ELYSIUM_PROVIDER", prov!);
      if (!config.apiKey) config = { ...config, apiKey: key, provider: prov as ProviderName, baseUrl: PROVIDER_URLS[prov!] };
      const masked = key.slice(0, 6) + "***" + key.slice(-3);
      console.log(`\n  ✓ Key saved for ${PROVIDER_NAMES[prov!] ?? prov}: ${masked}\n`);
      rl.prompt(); return;
    }
    if (input === "/connections") {
      console.log(`\n  ┌─────────────┬──────────────────────┬────────────────────┬─────────────┐`);
      console.log(`  │ Provider    │ Service              │ Model              │ Status      │`);
      console.log(`  ├─────────────┼──────────────────────┼────────────────────┼─────────────┤`);
      for (const [name, url] of Object.entries(PROVIDER_URLS)) {
        const provConfig = name === config.provider ? config : { ...config, provider: name, baseUrl: url };
        const key = name === config.provider ? config.apiKey : "";
        const model = name === config.provider ? config.model : PROVIDER_MODELS[name] || "";
        const status = name === config.provider ? "🟢 active" :
          (name === "ollama" || name === "opencode") ? "⚪ local" :
            key ? "🟢 configured" : "🔴 no key";
        console.log(`  │ ${name.padEnd(11)} │ ${(PROVIDER_NAMES[name] || name).padEnd(20)} │ ${model.padEnd(18)} │ ${status.padEnd(11)} │`);
      }
      console.log(`  └─────────────┴──────────────────────┴────────────────────┴─────────────┘\n`);
      rl.prompt(); return;
    }
    if (input === "/tools") {
      console.log(`\n  Available tools:`);
      for (const t of registry.list()) {
        console.log(`    ${t.name.padEnd(14)} ${t.description.slice(0, 65)}`);
      }
      console.log(`\n  Workspace: ${WORKSPACE}\n`);
      rl.prompt(); return;
    }
    if (input === "/workspace") {
      console.log(`\n  ${WORKSPACE}\n`);
      rl.prompt(); return;
    }

    // ── Agent turn ──
    try {
      const t0 = Date.now();
      const result = await agent.run(input);
      const dt = Date.now() - t0;
      let printed = false;
      for (const m of result.messages) {
        if (m.role === "assistant" && m.text) {
          console.log(`\n${m.text}`);
          printed = true;
        } else if (m.role === "tool_result") {
          const icon = m.isError ? "✗" : "✓";
          const preview = m.content.length > 120 ? m.content.slice(0, 120) + "…" : m.content;
          console.log(`  ${icon} ${m.toolName}: ${preview}`);
        }
      }
      if (!printed) console.log("\n  (no response)");
      console.log(`  ── ${result.turns}t ${result.usage.inputTokens}+${result.usage.outputTokens}tok ${dt}ms ──`);
    } catch (err: unknown) {
      console.error(`\n  ✗ Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    rl.prompt();
  });

  rl.on("close", () => process.exit(0));
}

// ── Single task ───────────────────────────────────────────────────

async function runSingleTask(config: ProviderConfig, task: string): Promise<void> {
  const registry = createToolRegistry();
  const agent = wireAgent(config, registry);
  const t0 = Date.now();
  const result = await agent.run(task);
  const dt = Date.now() - t0;
  for (const m of result.messages) {
    if (m.role === "assistant" && m.text) console.log(`\n${m.text}`);
    else if (m.role === "tool_result") console.log(`  → [${m.toolName}] ${m.isError ? "✗ " : ""}${m.content.slice(0, 200)}`);
  }
  console.log(`\n─── ${result.turns} turns, ${result.usage.inputTokens}+${result.usage.outputTokens} tokens, ${dt}ms ───`);
}

// ── Main ──────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`
Elysium Harness — AI Agent

Usage:
  pnpm agent                           Interactive REPL
  pnpm agent "do something"            Single task
  pnpm agent --task "do something"     Same as above
  pnpm agent --provider mock           Force offline mock mode
  pnpm agent --help                    Show this help

Slash commands (REPL):
  /model                  Show current provider and model
  /model <provider>       Switch provider
  /model <provider> <m>   Switch provider and model
  /connections            List all configured providers
  /key <provider> <key>   Set API key
  /tools                  List available tools
  /workspace              Show workspace path
  /clear                  Clear screen
  /help                   This help
  /quit                   Exit

Providers (all OpenAI-compatible):
  openai      GPT-4o, GPT-4o-mini, o1, o3
  deepseek    DeepSeek V3, R1
  groq        Llama 3, Mixtral, Gemma (some free)
  glm         ZhiPu GLM (glm-5.3-flash)
  opencode    OpenCode Go (Ollama cloud)
  ollama      Local models
  openrouter  100+ models via unified API
  together    Llama, Mixtral, Qwen, etc.
  mock        Offline deterministic mode

Configure: copy .env.example to .env, or use /key command in REPL.
`);
}

async function main(): Promise<void> {
  const { task, provider: providerOverride, help } = parseArgs(process.argv);
  if (help) { showHelp(); return; }

  let config = loadConfig(PROJECT_ROOT);
  if (providerOverride) config = { ...config, provider: providerOverride as ProviderName };

  if (task) {
    await runSingleTask(config, task);
  } else {
    await runRepl(config);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
