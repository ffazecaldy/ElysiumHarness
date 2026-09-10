# Elysium Harness — Architecture

Status: **approved Phase 1**. This document is normative. Changes require orchestrator approval and an entry in `doubts.md` (resolved section).

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      Extensions (opt-in)                     │
│  meta-layer │ extension-tools │ tui │ benchmarks │ cli       │
└──────┬───────────────┬──────────────┬──────────────┬─────────┘
       │ subscribe     │ register     │ render       │ measure
┌──────▼───────────────▼──────────────▼──────────────▼─────────┐
│                    @elysium/core (small)                     │
│  Agent Loop │ Tool System │ Session & State │ Orchestration  │
│  Quality Gate │ Provider Interface │ Event/Telemetry Bus     │
└──────┬───────────────┬──────────────┬──────────────┬─────────┘
       │               │              │              │
   LLM Providers   Files/Shell   JSONL Log    SpawnFn (depth ≤ 2)
 (mock, openai)   (policy-gated)  (tree)      (leaf agents only)
```

Dependency rule: extensions depend on core; core depends on **nothing** (Node stdlib only).

## 2. Core Public Interfaces (frozen in `core/src/types/`)

| Module | Key types | Behavior contract |
|---|---|---|
| **Agent Loop** | `Agent`, `AgentOptions`, `TurnResult` | Runs prompt → provider stream → tool executions → repeat until `end_turn`/`aborted`/`maxTurns`. Per-turn snapshot: the request sent to the provider is built once per turn (system prompt, messages, tools); config changes mid-turn apply to the *next* turn. Supports steering (queued user messages drained between turns) and abort via `AbortSignal`. |
| **Tool System** | `Tool`, `ToolRegistry`, `ToolContext`, `PathPolicy` | Registry validates names (unique), exposes `toDefinitions()` for the provider. `read`/`write`/`edit`/`bash` built in. All filesystem paths resolved against `ctx.cwd` and validated against `PathPolicy.allowedRoots` before I/O. |
| **Session & State** | `Session`, `SessionEntry`, `Checkpoint`, `CompactionResult` | Append-only JSONL tree (`id`/`parentId`). Branch = append under a different parent. Checkpoint = leaf pointer. Compaction = append a `summary` entry; context projection (`buildContext()`) substitutes covered entries with the summary — history is never rewritten. |
| **Orchestration** | `OrchestrationPlan`, `Orchestrator`, `SpawnFn`, `SubagentResult` | Depth ≤ 2 **by construction**: a plan carries exactly one level of subtasks; `SubagentResult` cannot contain a plan, so spawned agents have no API to spawn further. Builder/critic: optional critic pass with fresh context per subtask; repair rounds bounded. |
| **Quality Gate** | `QualityGate`, `Rubric`, `QualityScore`, `JudgeFn` | Weighted rubric scoring (0–10 per dimension, weighted mean). `evaluate()` returns accept/reject **with reasons** (targeted retry feedback). Two judge profiles: `structural` (deterministic, offline) and `llm-judge` (uses a provider). |
| **Providers** | `LlmProvider`, `StreamEvent`, `LlmRequest` | Async-iterable streaming; terminal `done` or `error` exactly once. Adapters: `MockProvider` (deterministic scripted; zero network), `OpenAICompatibleProvider` (SSE). |
| **Events** | `EventBus`, `HarnessEvent`, `EventHandler` | Typed pub/sub + bounded ring buffer (`recent(n)`). Every lifecycle moment emits: `task_started/ended`, `turn_started/ended`, `tool_called`, `token_usage`, `latency`, `quality_evaluated`, `error`. |

## 3. State Model

- **Run** = one top-level `Agent.run()` or `Orchestrator.execute()`. Owns a `runId` (ULID-style).
- **Session** = append-only entry tree; the active leaf defines current state. Persistence: one JSONL file per session under `.elysium/sessions/`.
- **Projection** = what the model sees: active-branch entries minus summary-covered entries plus summaries. Pure function of the log — replayable, measurable.
- **Checkpoints** are free (any leaf). **Branching** = append with `parentId` of an older entry. **Compaction** never destroys data.

## 4. Security Model

1. **Path containment** — `read`/`write`/`edit` resolve paths and reject anything escaping `allowedRoots` (symlink-aware: resolve real path first). Default roots: `[cwd]`.
2. **Bash policy** — `deniedCommands` regexes block; `warnCommands` flag in telemetry but execute; everything else allowed (default-allow, operator adds deny rules). Policy matched on the normalized command string.
3. **No secrets in code** — providers read credentials from `process.env` only; the harness never logs request headers.
4. **Telemetry is local** — JSONL under `.elysium/`; no network egress except configured providers.
5. **Depth cap** — orchestration cannot exceed depth 2 (type-level, see §2).

## 5. Telemetry Format (normative)

Every event is one JSON line:
```json
{
  "type": "task_ended",
  "timestamp": "2026-09-10T12:00:00.000Z",
  "runId": "01JABC...",
  "taskId": "subtask-3",
  "data": { "status": "pass", "durationMs": 1421, "tokens": { "inputTokens": 530, "outputTokens": 210 } }
}
```
Required `data` keys per type: `tool_called` → `{tool, durationMs, isError}`; `token_usage` → `{inputTokens, outputTokens}`; `latency` → `{scope: "turn"|"task"|"run", durationMs}`; `quality_evaluated` → `{weighted, passed}`; `error` → `{message, scope}`. The Meta-Layer persists exactly these lines — the format is the contract between core and meta-layer.

## 6. Meta-Layer (extension) Loop

```
subscribe(eventBus) ──► TelemetryStore (JSONL, queryable by run/task/type/time)
       │                       │
       ▼                       ▼
 HypothesisEngine ◄── observations (aggregates: slow tasks, low first-pass, retry storms)
       │  proposes: {id, observation, change, expectedEffect, status}
       ▼
 ControlledApplication (config deltas only: retry counts, granularity, tool ordering)
       │
       ▼
 DeltaMeasurement (re-run held-out tasks; promote iff delta > 0, else reject + log)
```

Hypothesis JSON (normative):
```json
{ "id": "hyp_01J...", "observation": {"metric": "first_pass_rate", "value": 0.62, "window": "last_20_tasks"},
  "change": {"kind": "retry_policy", "from": {"maxRetries": 1}, "to": {"maxRetries": 2}},
  "expectedEffect": "first_pass_rate +0.05 or more",
  "status": "proposed", "delta": null }
```

## 7. Core / Extension Boundary (definitive)

**Core:** agent loop, tool system + 4 built-ins, session & state, orchestration primitives (depth ≤ 2), streaming quality gate, provider interface + mock, event bus.
**Extensions:** meta-layer, extra tools (grep/glob/http-fetch), OpenAI adapter (network), TUI, benchmarks, CLI, anything else — forever.

## 8. Measurement

Defined in `plan.md` §Measurement: first-pass rate, token usage, latency, quality score (weights: correctness .30 / efficiency .30 / maintainability .20 / principles .20). Benchmarks compare against `docs/baseline.md`; no arbitrary numeric targets.
