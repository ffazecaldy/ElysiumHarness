# Elysium Harness

A next-generation agent harness: a **minimal, auditable core** (Pi-inspired) with **hierarchical orchestration (depth ≤ 2)** and **streaming quality gates** as first-class, opt-in extensions (Elysium-Swarmloop-inspired).

```
┌──────────────────────────────────────────────────────────────┐
│                      Extensions (opt-in)                     │
│  meta-layer │ extension-tools │ tui │ benchmarks │ cli       │
└──────┬───────────────┬──────────────┬──────────────┬─────────┘
┌──────▼───────────────▼──────────────▼──────────────▼─────────┐
│                    @elysium/core (small)                     │
│  Agent Loop │ Tool System │ Session │ Orchestration │        │
│  Quality Gate │ Provider Interface │ Event/Telemetry Bus     │
└──────────────────────────────────────────────────────────────┘
```

## Packages

| Package | Kind | What it gives you |
|---|---|---|
| `@elysium/core` | core | Agent loop, tool system (`read`/`write`/`edit`/`bash`), JSONL session tree, depth-2 orchestrator, quality gate, providers (mock + OpenAI-compatible), typed event bus |
| `@elysium/meta-layer` | extension | Software Factory meta-layer: telemetry store, improvement hypotheses, controlled application, delta promotion |
| `@elysium/extension-tools` | extension | `grep`, `glob`, `http_fetch` tools |
| `@elysium/tui` | extension | Readline REPL with live streaming |
| `@elysium/benchmarks` | extension | Benchmark/eval suite, baseline management |
| `@elysium/cli` | extension | `elysium demo / run / orchestrate` |

## Quick start

Requires Node ≥ 22 and pnpm ≥ 9.

```bash
pnpm install
pnpm build          # typechecks every package (strict, zero errors)
pnpm test           # full unit + integration suite
pnpm demo           # offline end-to-end agent run on the deterministic mock provider
```

The demo runs a complete agent loop with **zero network**: a scripted provider requests a tool call, the harness executes it through the policy-checked tool registry, and the agent produces a final answer.

## 60-second programmatic tour

```ts
import {
  Agent, MockProvider, ToolRegistry, createBuiltinTools, Session, EventBus,
} from "@elysium/core";

const bus = new EventBus();
const policy = { allowedRoots: [process.cwd()] };
const registry = new ToolRegistry();
for (const tool of createBuiltinTools(policy)) registry.register(tool);

const session = new Session({ filePath: ".elysium/sessions/demo.jsonl" });
const provider = new MockProvider([{ text: "Ready." }]); // or OpenAICompatibleProvider

const agent = new Agent({
  systemPrompt: "You are a coding agent.",
  provider,
  tools: registry.list(),
  executeTool: async (call, ctx) => {
    const tool = registry.get(call.name);
    if (!tool) {
      return { role: "tool_result", toolCallId: call.id, toolName: call.name, content: "unknown tool", isError: true };
    }
    const result = await tool.execute(call.arguments, { cwd: process.cwd(), signal: ctx.signal, emit: (e) => bus.emit(e) });
    return { role: "tool_result", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.isError };
  },
});

const run = await agent.run("List the tools you have.");
session.appendUser("List the tools you have.");
for (const m of run.messages) session.appendUser /* or appendAssistant/appendToolResult */(m);
bus.on((e) => process.stdout.write(`[${e.type}] ${JSON.stringify(e.data)}\n`));
```

## Orchestration (depth ≤ 2, by construction)

```ts
import { Orchestrator } from "@elysium/core";

const orchestrator = new Orchestrator({ spawn: mySpawnFn, maxConcurrency: 4, repairRounds: 1 });
const report = await orchestrator.execute({
  goal: "Ship the feature",
  maxDepth: 2,              // the only legal value — anything else is rejected
  subtasks: [{ id: "t1", goal: "Implement X", acceptanceCriteria: ["X works"] }],
});
```

A spawned subagent **cannot** spawn further agents: `SubagentResult` carries no plan, so depth 3 is impossible by construction, not by convention.

## Quality gates

```ts
import { QualityGate, createDefaultRubric } from "@elysium/core";

const gate = new QualityGate();                    // deterministic structural judge
const score = await gate.evaluate(
  { kind: "code", content: generatedCode, criteria: ["handles abort", "no stubs"] },
  createDefaultRubric(),                           // correctness .3 / efficiency .3 / maintainability .2 / principles .2
);
if (!score.passed) console.log(score.reasons);     // targeted retry feedback
```

For live judging, swap in `createLlmJudge(provider)`.

## Interactive agent (`pnpm agent`)

`pnpm agent` starts a REPL (mock, offline mode until a real provider is configured with `/key` or `.env`). Commands:

| Command | Behavior |
|---|---|
| `/model` | Show current provider/model and available providers |
| `/model <provider>` | Switch provider (`openai`, `deepseek`, `groq`, `together`, `openrouter`, `glm`, `opencode`, `ollama`, `mock`) |
| `/model <provider> <model>` | Switch provider and model |
| `/key <provider> <key>` | Save an API key to `.env` (never echoed fully); then run `/model <provider>` to activate |
| `/connections` | Provider status table (configured / key-required) |
| `/tools` | List registered tools |
| `/workspace` | Show the workspace path |
| `/clear`, `/help`, `/quit` | Clear screen, help, exit |

Provider switching is **transactional**: the target provider is built and validated *before* the live agent is touched. A failed switch (unknown provider, missing API key, initialization error) leaves the previous provider active and running — the REPL prints the error plus a suggested fix and stays alive.

**Smart suggestions**: an unknown provider name gets a closest-match suggestion (edit-distance), e.g. `/model openIA` → *did you mean 'openai'?*.

**Ctrl+C abort**: pressing Ctrl+C during an in-flight agent turn aborts the current turn (via the turn's `AbortSignal`) and returns to the prompt; the provider session and REPL state survive. Pressing it at the prompt exits cleanly.

## Meta-Layer (self-improvement loop, extension)

The meta-layer subscribes to the event bus, persists telemetry verbatim (JSONL), aggregates observations (first-pass rate, latency), proposes **config-delta hypotheses** (never code patches), applies them under control, re-measures on held-out runs, and promotes only positive deltas (auto-rollback otherwise). See `docs/architecture.md` §5–6 for the normative event and hypothesis formats.

## Benchmarks

```ts
import { BenchmarkRunner, createStandardScenarios, writeBaseline, compare } from "@elysium/benchmarks";
const summary = await new BenchmarkRunner().runAll(createStandardScenarios());
// first-pass rate, token usage, latency, quality score — compare vs docs/baseline.md
```

Metrics are defined in `plan.md` §Measurement; the committed baseline lives in `docs/baseline.md`.

## Security model (summary)

- **Path containment**: filesystem tools resolve real paths and refuse anything outside `allowedRoots` (symlink-aware).
- **Command policy**: `deniedCommands` regexes block, `warnCommands` flag in telemetry, default-allow otherwise.
- **Secrets**: providers read keys from your environment / constructor and never log them.
- **Telemetry**: local JSONL only; no egress beyond configured providers.

Full model: `docs/architecture.md` §4.

## Documentation

- `docs/architecture.md` — normative architecture, public interfaces, state model, telemetry format
- `prd.md` / `plan.md` / `ideas.md` / `doubts.md` — build-time context files (living documents)
- `PHASE_BUILD.md` — the frozen API contract used to build the system itself

## License

MIT
