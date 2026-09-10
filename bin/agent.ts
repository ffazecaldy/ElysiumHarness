#!/usr/bin/env node
/**
 * Elysium Harness — AI Agent CLI
 *
 * Usage:
 *   pnpm agent                     — interactive REPL
 *   pnpm agent --task "do something" — single task
 *   pnpm agent --provider mock      — force mock (offline)
 *   pnpm agent --help               — show help
 *
 * Configure providers via .env file (see .env.example).
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
  type ToolContext,
  type ToolResultMessage,
  type ToolCallPart,
  type HarnessEvent,
} from "@elysium/core";
import { loadConfig, describeConfig, type ProviderConfig } from "../packages/cli/src/config";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const WORKSPACE = fs.mkdtempSync(path.join(
  process.env.TEMP || process.env.TMP || "/tmp",
  "elysium-",
));

const SYSTEM_PROMPT = `You are Elysium, an AI coding agent. You have access to tools for reading, writing, editing files, and executing commands. Use them when needed to fulfill the user's request. Be concise and direct. Always explain what you did.`;

function createProvider(config: ProviderConfig) {
  if (config.provider === "mock") {
    return new MockProvider([
      { text: "I am running in mock mode (offline). Configure a real provider in .env to use a real LLM." },
    ]);
  }
  if (!config.apiKey && config.provider !== "ollama") {
    console.error(`\n  ⚠  No API key for ${config.provider}.`);
    console.error(`  Copy .env.example to .env and add your key:\n`);
    console.error(`    cp .env.example .env`);
    console.error(`    # edit .env with your API key\n`);
    process.exit(1);
  }
  return new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey || "ollama",
    model: config.model,
  });
}

function createTools(): Tool[] {
  const policy = { allowedRoots: [WORKSPACE, process.cwd()] };
  return createBuiltinTools(policy);
}

function wireAgent(config: ProviderConfig): Agent {
  const provider = createProvider(config);
  const registry = new ToolRegistry();
  for (const tool of createTools()) registry.register(tool);

  return new Agent({
    systemPrompt: SYSTEM_PROMPT,
    provider,
    tools: registry.list(),
    maxTurns: 8,
    executeTool: async (call: ToolCallPart, ctx: { signal: AbortSignal }): Promise<ToolResultMessage> => {
      const tool = registry.get(call.name);
      if (!tool) {
        return {
          role: "tool_result",
          toolCallId: call.id,
          toolName: call.name,
          content: `unknown tool: ${call.name}`,
          isError: true,
        };
      }
      const t0 = Date.now();
      try {
        const result = await tool.execute(call.arguments, {
          cwd: WORKSPACE,
          signal: ctx.signal,
          emit: () => undefined,
        });
        return {
          role: "tool_result",
          toolCallId: call.id,
          toolName: call.name,
          content: result.content,
          isError: result.isError,
          ...(result.details !== undefined ? { details: result.details } : {}),
        };
      } catch (err: unknown) {
        return {
          role: "tool_result",
          toolCallId: call.id,
          toolName: call.name,
          content: `error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        };
      }
    },
  });
}

function parseArgs(argv: string[]): { task: string | null; provider: string | null; help: boolean } {
  let task: string | null = null;
  let provider: string | null = null;
  let help = false;
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--task" && args[i + 1]) task = args[++i] ?? null;
    else if (arg === "--provider" && args[i + 1]) provider = args[++i] ?? null;
    else if (!arg.startsWith("-")) task = arg;
  }
  return { task, provider, help };
}

function showHelp(): void {
  console.log(`
Elysium Harness — AI Agent

Usage:
  pnpm agent                           Interactive REPL
  pnpm agent "do something"            Single task (then exit)
  pnpm agent --task "do something"     Same as above
  pnpm agent --provider mock           Force offline mock mode
  pnpm agent --help                    Show this help

Configuration:
  Copy .env.example to .env and fill in your API key.
  Supported: openai, deepseek, groq, together, openrouter, ollama, mock

Workspace: ${WORKSPACE}
  Files created by the agent land here (and in your cwd).
`);
}

function printBanner(config: ProviderConfig): void {
  console.log(`
  ╔══════════════════════════════════════╗
  ║     ⚡  Elysium Harness  ⚡         ║
  ║     AI Agent with Tool Use          ║
  ╚══════════════════════════════════════╝
`);
  console.log(`  Provider: ${describeConfig(config)}`);
  console.log(`  Workspace: ${WORKSPACE}`);
  console.log(`  Type /quit to exit, /tools to list tools.\n`);
}

async function runSingleTask(agent: Agent, task: string): Promise<void> {
  const t0 = Date.now();
  const result = await agent.run(task);
  const dt = Date.now() - t0;
  for (const m of result.messages) {
    if (m.role === "assistant" && m.text) {
      console.log(`\n${m.text}`);
    } else if (m.role === "tool_result") {
      console.log(`  → [${m.toolName}] ${m.isError ? "✗ " : ""}${m.content.slice(0, 200)}`);
    }
  }
  console.log(`\n─── ${result.turns} turns, ${result.usage.inputTokens}+${result.usage.outputTokens} tokens, ${dt}ms ───`);
}

async function runRepl(agent: Agent, config: ProviderConfig): Promise<void> {
  printBanner(config);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "⚡ > ",
  });

  const tools = createTools();
  rl.prompt();

  rl.on("line", async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input === "/quit" || input === "/exit") {
      console.log("\n  👋 Goodbye.\n");
      process.exit(0);
    }
    if (input === "/tools") {
      console.log("\n  Available tools:");
      for (const t of tools) {
        console.log(`    ${t.name.padEnd(14)} ${t.description.slice(0, 60)}`);
      }
      console.log(`\n  Workspace: ${WORKSPACE}\n`);
      rl.prompt();
      return;
    }
    if (input.startsWith("/workspace")) {
      console.log(`\n  ${WORKSPACE}\n`);
      rl.prompt();
      return;
    }

    try {
      const t0 = Date.now();
      const result = await agent.run(input);
      const dt = Date.now() - t0;
      let printedAny = false;
      for (const m of result.messages) {
        if (m.role === "assistant" && m.text) {
          console.log(`\n${m.text}`);
          printedAny = true;
        } else if (m.role === "tool_result") {
          const icon = m.isError ? "✗" : "✓";
          const preview = m.content.length > 120 ? m.content.slice(0, 120) + "…" : m.content;
          console.log(`  ${icon} ${m.toolName}: ${preview}`);
        }
      }
      if (!printedAny) console.log("\n  (no response)");
      console.log(`  ── ${result.turns}t ${result.usage.inputTokens}+${result.usage.outputTokens}tok ${dt}ms ──`);
    } catch (err: unknown) {
      console.error(`\n  ✗ Error: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    rl.prompt();
  });

  rl.on("close", () => process.exit(0));
}

async function main(): Promise<void> {
  const { task, provider: providerOverride, help } = parseArgs(process.argv);
  if (help) { showHelp(); return; }

  let config = loadConfig(PROJECT_ROOT);
  if (providerOverride) config = { ...config, provider: providerOverride as typeof config.provider };
  if (config.provider !== "mock" && config.provider !== "ollama" && !config.apiKey) {
    console.error(`  ⚠  No API key for ${config.provider}. Copy .env.example to .env and add your key.\n`);
    process.exit(1);
  }

  const agent = wireAgent(config);

  if (task) {
    await runSingleTask(agent, task);
  } else {
    await runRepl(agent, config);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
