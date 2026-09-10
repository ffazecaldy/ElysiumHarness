# Elysium Harness — PRD

## Problem
Agent harnesses today are either minimal-but-featureless (no orchestration, no quality control) or powerful-but-monolithic (impossible to extend, impossible to measure). There is no small, hackable core that ships with hierarchical orchestration and measurable quality gates as first-class, optional extensions.

## Product
**Elysium Harness** — a next-generation agent harness built on two lineages:
- **From Pi Agent (earendil-works/pi):** minimal core, tool system, session model, extensibility.
- **From Elysium-Swarmloop:** depth-2 hierarchical orchestration, streaming quality gates, builder/critic separation, state machine discipline.

## Users
- Developers building custom agents who want a small auditable core.
- Researchers who need measurable, comparable agent runs (tokens, latency, first-pass rate, quality).
- Teams who want orchestration and quality gating as opt-in extensions, not baked-in behavior.

## Requirements (numbered, testable)
1. R1 — The core packages build with `pnpm build` and pass `pnpm test` with zero errors.
2. R2 — The agent loop runs a full cycle: prompt → provider stream → tool call → tool result → final answer.
3. R3 — Tools are registered in a registry; built-ins: `read`, `write`, `edit`, `bash`. Extensions add more without touching core.
4. R4 — Sessions persist as append-only JSONL; supports checkpoint, branch, and compaction.
5. R5 — Orchestration supports depth ≤ 2 (orchestrator → subagents). Depth 3+ is rejected by construction.
6. R6 — Quality gates evaluate structured output against a weighted rubric and accept/reject with reasons.
7. R7 — A multi-provider LLM interface exists; at least one real adapter (OpenAI-compatible) and one deterministic mock adapter for tests/benchmarks.
8. R8 — A typed event/telemetry bus emits structured events (task start/end, token usage, latency, errors, tool calls) queryable by extensions.
9. R9 — The Meta-Layer (extension) observes telemetry, stores it queryably, generates improvement hypotheses, applies them under control, measures deltas, and promotes only positive deltas.
10. R10 — The benchmark suite measures first-pass rate, token usage, latency, quality score, and compares against a documented baseline (`docs/baseline.md`).
11. R11 — The CLI runs an example task end-to-end offline (mock provider) with `pnpm demo`.
12. R12 — Everything (code, comments, docs) is in English. TypeScript strict, no unjustified `any`.

## Acceptance Criteria
- `pnpm build` green across all packages; `pnpm test` green (unit + integration).
- `pnpm demo` runs an example task end-to-end using the mock provider, no network.
- Benchmark suite executes and writes results to `benchmarks/results/` + updates `docs/baseline.md` when `--update-baseline` is passed.
- A third party can clone, `pnpm install`, `pnpm build`, `pnpm demo` following README alone.

## Non-Goals
- No visual design system (CLI/TUI product).
- No multi-tenant/server mode.
- No runtime prompt rules baked into code (runtime modes are data/config, implemented as product features).
- No arbitrary numeric performance targets — only measured baselines vs. documented comparisons.

## Architecture (chosen)
pnpm monorepo, Node ≥ 22, TypeScript strict, tsup (build), tsx (dev), vitest (test), biome (lint/format).

| Package | Role | Kind |
|---|---|---|
| `@elysium/core` | agent loop, tools, session, orchestration primitives, quality gate, providers, events | core (small) |
| `@elysium/meta-layer` | telemetry store, hypothesis engine, delta promotion | extension |
| `@elysium/extension-tools` | extra tools: grep, glob, http-fetch | extension |
| `@elysium/tui` | terminal UI (REPL + rendering) | extension |
| `@elysium/benchmarks` | benchmark + eval suite, baseline management | extension |
| `@elysium/cli` | binary entry point, wiring | extension |

## Security & Privacy
- Bash tool executes with an explicit allow/deny command policy; sandboxing is the operator's responsibility (documented).
- No secrets in code; providers read API keys from environment variables only.
- Telemetry files are local by default; no network egress except configured providers.

## Compatibility
- Windows / macOS / Linux; Node ≥ 22; pnpm ≥ 9.
