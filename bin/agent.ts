#!/usr/bin/env node
/**
 * Elysium Harness — AI Agent CLI
 *
 *   pnpm agent                     Interactive REPL
 *   pnpm agent "do something"      Single task
 *   pnpm agent --help              Show help
 *
 * Slash commands in REPL: /model /key /connections /tools /workspace /clear /help /quit
 *
 * Providers are configured in .env (see .env.example) or via /key.
 *
 * Error policy: recoverable errors (missing key, unknown provider, failed
 * switch) are caught by the command error boundary and displayed — the REPL
 * always keeps running. Only startup failures may terminate the process,
 * and only from this entrypoint.
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
  MissingApiKeyError,
  ProviderInitializationError,
  UnknownProviderError,
  RecoverableCliError,
  type ToolResultMessage,
  type ToolCallPart,
  makeEvent,
  type EventBus,
} from "@elysium/core";
import { EventBus as RealEventBus } from "@elysium/core";
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

// ── Event bus (shared: meta-layer & CLI both consume) ─────────────

const eventBus: EventBus = new RealEventBus({ bufferSize: 2000 });

/** Emit a CLI error as a structured event (no secrets in payload, ever). */
function emitCliError(kind: string, message: string): void {
  eventBus.emit({
    type: "error",
    timestamp: new Date().toISOString(),
    data: { scope: "cli", kind, message },
  });
}

// ── Provider factory: THROWS typed errors, NEVER process.exit ─────

const CREDENTIAL_LESS = new Set<string>(["mock", "ollama"]);

function makeProvider(config: ProviderConfig) {
  if (config.provider === "mock") {
    return new MockProvider([
      { text: "I am running in mock mode (offline). Configure a real provider with /key or .env file." },
    ]);
  }
  return new OpenAICompatibleProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey || "ollama",
    model: config.model,
  });
}

/**
 * Validate + attempt to initialize the candidate provider BEFORE committing.
 * Throws typed RecoverableCliError subclasses only — never process.exit.
 */
function assertSwitchable(candidate: ProviderConfig): void {
  if (!(candidate.provider in PROVIDER_URLS)) {
    throw new UnknownProviderError(candidate.provider);
  }
  if (!CREDENTIAL_LESS.has(candidate.provider) && !candidate.apiKey) {
    throw new MissingApiKeyError(candidate.provider);
  }
}

function wireAgentFor(config: ProviderConfig, registry: ToolRegistry): Agent {
  const provider = makeProvider(config);
  return new Agent({
    systemPrompt: SYSTEM_PROMPT,
    provider,
    tools: registry.list(),
    maxTurns: 8,
    executeTool: async (call, ctx): Promise<ToolResultMessage> => {
      const tool = registry.get(call.name);
      if (!tool) {
        return { role: "tool_result", toolCallId: call.id, toolName: call.name, content: `unknown tool: ${call.name}`, isError: true };
      }
      try {
        const result = await tool.execute(call.arguments, { cwd: WORKSPACE, signal: ctx.signal, emit: (e) => eventBus.emit(e) });
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

// ── Edit-distance for the /model suggestion ──────────────────────

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i]![0] = i;
  for (let j = 0; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length]![b.length]!;
}

function suggestProvider(name: string): string | null {
  let best: string | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const known of Object.keys(PROVIDER_URLS)) {
    const d = editDistance(name, known);
    if (d < bestDist) {
      bestDist = d;
      best = known;
    }
  }
  return best && bestDist <= Math.max(2, Math.floor(name.length / 3)) ? best : null;
}

// ── Command dispatcher (transactional provider switching) ────────

interface ReplState {
  config: ProviderConfig;
  /** Live provider state: the committed config the agent is wired to. */
  committed: ProviderConfig;
}

function renderRecoverableError(title: string, action: string): void {
  console.log(`\n  ⚠️  ${title}`);
  if (action) console.log(`  → ${action}`);
  console.log(`\n`);
}

async function dispatchCommand(
  input: string,
  state: ReplState,
  registry: ToolRegistry,
  rebuildAgent: (config: ProviderConfig) => void,
): Promise<void> {
  // /quit and /clear are handled by the caller (process-level).
  if (input === "/help") {
    console.log(`
  Commands:
    /model                  Show current provider and model
    /model <provider>       Switch provider (openai | deepseek | groq | together | openrouter | glm | opencode | ollama | mock)
    /model <provider> <m>   Switch provider and model
    /connections            Provider status table
    /key <provider> <key>   Set API key (saved to .env, never echoed fully)
    /tools                  List tools
    /workspace              Show workspace path
    /clear                  Clear screen
    /help                   This help
    /quit                   Exit
`);
    return;
  }
  if (input === "/model") {
    console.log(`\n  Current: ${describeConfig(state.config)}`);
    console.log(`\n  Available providers:`);
    for (const [k, v] of Object.entries(PROVIDER_NAMES)) {
      console.log(`    ${(k === state.committed.provider ? "* " : "  ")}${k.padEnd(12)} ${v}`);
    }
    console.log();
    return;
  }
  if (input.startsWith("/model ")) {
    const parts = input.slice(7).trim().split(/\s+/);
    const target = parts[0] as string;
    const targetModel = parts[1];
    if (!(target in PROVIDER_URLS)) {
      const suggestion = suggestProvider(target);
      let msg = `Unknown provider: ${target}`;
      if (suggestion) msg += ` — did you mean '${suggestion}'?`;
      throw new UnknownProviderError(target);
    }
    // Build candidate config, validate BEFORE touching the live one.
    // Read the provider's key from the live .env (user may have set it via /key).
    const freshEnv = loadConfig(PROJECT_ROOT);
    const candidateKey = target === freshEnv.provider
      ? freshEnv.apiKey
      : target === state.committed.provider ? state.committed.apiKey : "";
    const candidate: ProviderConfig = {
      ...state.committed,
      provider: target as ProviderName,
      baseUrl: PROVIDER_URLS[target] ?? "",
      model: targetModel ?? PROVIDER_MODELS[target] ?? "",
      apiKey: candidateKey,
    };
    assertSwitchable(candidate);
    // Initialize the candidate provider before committing.
    let candidateAgent: Agent;
    try {
      candidateAgent = wireAgentFor(candidate, registry);
    } catch (err: unknown) {
      if (err instanceof RecoverableCliError) throw err;
      throw new ProviderInitializationError(
        `Provider ${target} failed to initialize: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Commit only on success: rebuild the live agent onto the candidate.
    state.committed = candidate;
    state.config = candidate;
    rebuildAgent(candidate);
    void candidateAgent;
    saveEnvValue(PROJECT_ROOT, "ELYSIUM_PROVIDER", target);
    if (targetModel) saveEnvValue(PROJECT_ROOT, "ELYSIUM_MODEL", targetModel);
    console.log(`\n  ✓ Active provider: ${describeConfig(candidate)}\n`);
    return;
  }
  if (input.startsWith("/key ")) {
    const parts = input.slice(5).trim().split(/\s+/);
    if (parts.length < 2) {
      throw new RecoverableCliError("Missing arguments", "Usage: /key <provider> <api-key>");
    }
    const prov = parts[0]!;
    const key = parts.slice(1).join(" ");
    if (!(prov in PROVIDER_URLS)) {
      throw new UnknownProviderError(prov);
    }
    if (key.length < 4) {
      throw new RecoverableCliError("API key too short to be valid", `Usage: /key ${prov} <your-api-key>`);
    }
    saveEnvValue(PROJECT_ROOT, "ELYSIUM_API_KEY", key);
    saveEnvValue(PROJECT_ROOT, "ELYSIUM_PROVIDER", prov);
    const masked = key.slice(0, 6) + "***" + key.slice(-3);
    console.log(`\n  ✅ Key saved for ${PROVIDER_NAMES[prov] ?? prov}: ${masked}`);
    console.log(`  → Now switch: /model ${prov}\n`);
    return;
  }
  if (input === "/connections") {
    console.log(`\n  Providers (configured in .env or via /key):`);
    for (const [name, url] of Object.entries(PROVIDER_URLS)) {
      const configured = name in CREDENTIAL_LESS ? "ready (no key needed)" : "key required (/key <provider> <key>)";
      console.log(`    ${name.padEnd(12)} ${String(PROVIDER_NAMES[name]).padEnd(16)} ${url.padEnd(40)} ${configured}`);
    }
    console.log();
    return;
  }
  if (input === "/tools") {
    console.log(`\n  Available tools:`);
    for (const t of registry.list()) {
      console.log(`    ${t.name.padEnd(14)} ${t.description.slice(0, 65)}`);
    }
    console.log(`\n  Workspace: ${WORKSPACE}\n`);
    return;
  }
  if (input === "/workspace") {
    console.log(`\n  ${WORKSPACE}\n`);
    return;
  }
  if (input.startsWith("/")) {
    const cmd = input.split(/\s+/)[0] ?? "";
    console.log(`\n  ⚠️  Unknown command: ${cmd}`);
    console.log(`  → /help lists available commands\n`);
    return;
  }
}

// ── REPL loop with command error boundary ────────────────────────

async function runRepl(startConfig: ProviderConfig): Promise<void> {
  const registry = createToolRegistry();
  const state: ReplState = { config: startConfig, committed: startConfig };
  let agent = wireAgentFor(state.committed, registry);

  console.log("\n  ╔══════════════════════════════════════════╗");
  console.log("  ║        ⚡  Elysium Harness  ⚡           ║");
  console.log("  ║        AI Agent with Tool Use            ║");
  console.log("  ╚══════════════════════════════════════════╝\n");
  console.log(`  Provider: ${describeConfig(state.committed)}`);
  console.log(`  Workspace: ${WORKSPACE}`);
  console.log("  Type /help for commands.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "⚡ > " });
  rl.prompt();

  // Serialize line handling: piped readline fires faster than async
  // handlers settle, so /quit could otherwise exit before earlier
  // commands finish (this caused the original "silent no-op" symptom).
  let lineQueue: Promise<void> = Promise.resolve();
  rl.on("line", (raw: string) => {
    lineQueue = lineQueue
      .then(() => handleReplLine(raw, { state, registry, setAgent: (a) => { agent = a; }, getAgent: () => agent }))
      .catch((err: unknown) => {
        console.error(`\n  ✗ Command loop error: ${err instanceof Error ? err.message : String(err)}\n`);
      })
      .finally(() => rl.prompt());
  });

  rl.on("close", () => process.exit(0));
}

interface ReplContext {
  state: ReplState;
  registry: ToolRegistry;
  setAgent: (agent: Agent) => void;
  getAgent: () => Agent;
}

async function handleReplLine(input: string, xo: ReplContext): Promise<void> {
  const line = input.trim();
  if (!line) return;
  if (line === "/quit" || line === "/exit") {
    console.log("\n  👋 Goodbye.\n");
    process.exit(0);
  }
  if (line === "/clear") { console.clear(); return; }

  // ── Command error boundary: recoverable errors keep the REPL alive ──
  if (line.startsWith("/")) {
    try {
      await dispatchCommand(line, xo.state, xo.registry, (nextConfig) => {
        xo.setAgent(wireAgentFor(nextConfig, xo.registry));
      });
    } catch (err: unknown) {
      if (err instanceof RecoverableCliError) {
        emitCliError("recoverable_command_error", `${err.name}: ${err.message}`);
        renderRecoverableError(`${err.message} (provider stays: ${xo.state.committed.provider})`, err.action);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        emitCliError("internal_command_error", msg);
        console.error(`\n  ✗ Internal command error (logged): ${msg}`);
        console.error("  The REPL stays alive. Please report this if it recurs.\n");
      }
    }
    return;
  }

  // ── Agent turn ──
  try {
    const t0 = Date.now();
    const agent = xo.getAgent();
    const result = await agent.run(line);
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
    if (err instanceof RecoverableCliError) {
      renderRecoverableError(err.message, err.action);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      emitCliError("agent_run_error", msg);
      console.error(`\n  ✗ Agent error (logged): ${msg}\n`);
    }
  }
}

// ── Single task mode ─────────────────────────────────────────────

async function runSingleTask(config: ProviderConfig, task: string): Promise<void> {
  const registry = createToolRegistry();
  // Startup gate (fatal, entrypoint-level only): missing credentials for a
  // non-interactive single task CANNOT be recovered interactively.
  if (!(config.provider in PROVIDER_URLS) && config.provider !== "mock") {
    console.error(`  ⚠  Unknown provider: ${config.provider}`);
    process.exit(1);
  }
  if (!CREDENTIAL_LESS.has(config.provider) && !config.apiKey) {
    console.error(`\n  ⚠  No API key for ${PROVIDER_NAMES[config.provider] ?? config.provider}.`);
    console.error(`  → Add it to .env or run: pnpm agent, then /key ${config.provider} <key>\n`);
    process.exit(1);
  }
  const agent = wireAgentFor(config, registry);
  const t0 = Date.now();
  const result = await agent.run(task);
  const dt = Date.now() - t0;
  for (const m of result.messages) {
    if (m.role === "assistant" && m.text) console.log(`\n${m.text}`);
    else if (m.role === "tool_result") console.log(`  → [${m.toolName}] ${m.isError ? "✗ " : ""}${m.content.slice(0, 200)}`);
  }
  console.log(`\n─── ${result.turns} turns, ${result.usage.inputTokens}+${result.usage.outputTokens} tokens, ${dt}ms ───`);
}

function createToolRegistry(): ToolRegistry {
  const policy = { allowedRoots: [WORKSPACE, process.cwd()] };
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools(policy)) registry.register(tool);
  return registry;
}

// ── Safety nets (entrypoint only, never inside core) ────────────

let replActive = false;

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  emitCliError("unhandled_rejection", msg);
  if (replActive) {
    console.error(`\n  ✗ [unhandledRejection, logged, still alive] ${msg}\n`);
    process.stdout.write("⚡ > ");
  } else {
    console.error(`  ✗ Unhandled rejection: ${msg}`);
  }
});

process.on("uncaughtException", (err) => {
  emitCliError("uncaught_exception", err.message);
  if (replActive) {
    console.error(`\n  ✗ [uncaughtException, logged, still alive] ${err.message}\n`);
    process.stdout.write("⚡ > ");
  } else {
    console.error(err);
    process.exit(1);
  }
});

function showHelp(): void {
  console.log(`
Elysium Harness — AI Agent

Usage:
  pnpm agent                           Interactive REPL
  pnpm agent "do something"            Single task
  pnpm agent --provider mock           Force offline mock mode
  pnpm agent --help                    Show this help

Providers: openai | deepseek | groq | together | openrouter | glm | opencode | ollama | mock
Configure: copy .env.example to .env, or /key <provider> <key> in the REPL.
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let taskArg: string | null = null;
  let providerArg: string | null = null;
  if (argv.includes("--help") || argv.includes("-h")) { showHelp(); return; }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--task" && argv[i + 1]) { taskArg = argv[i + 1] ?? null; i += 1; continue; }
    if (argv[i] === "--provider" && argv[i + 1]) { providerArg = argv[i + 1] ?? null; i += 1; continue; }
    if (argv[i] && !argv[i]!.startsWith("-")) taskArg = argv[i];
  }
  let config = loadConfig(PROJECT_ROOT);
  if (providerArg) config = { ...config, provider: providerArg as ProviderName };

  replActive = true;
  if (taskArg) {
    replActive = false;
    await runSingleTask(config, taskArg);
  } else {
    await runRepl(config);
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? err.message : err);
    process.exit(1);
  });
} else {
  void main();
}
