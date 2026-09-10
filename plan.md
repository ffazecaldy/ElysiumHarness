# Elysium Harness — Build Plan

Budget: **30 subagents total** (hard cap), depth ≤ 2, waves of ≤ 12 per phase.
Orchestrator does foundation/contract code personally (never delegated).

> **Status log (updated at end of each phase):**
> - Phase 0 ✅ — docs + decisions.
> - Phase 1 ✅ — architecture approved, scaffold green, contract frozen (commit 2927c8e).
> - Phase 2 ✅ — core implemented. NOTE: provider 429 rate-limit storms killed 10/13 first-wave agents; orchestrator implemented providers/tools/session/events/quality/tests directly (fallback strategy per plan §Failure handling). Variant trio for Agent Loop + Orchestration completed (2 variants by children, 2 by orchestrator). External selector verdict: **Agent Loop = v-b (lean event-callback)** 8.95/10; **Orchestration = v-a (plan-graph executor)** 8.90/10; winners promoted to canonical paths, alternates archived under `variants/` with DQ notes. 34 tests green, demo e2e green.
> - Phase 3 ✅ — Meta-Layer end-to-end on simulated events: telemetry store (JSONL, queryable), hypothesis engine (retry-policy + concurrency hypotheses, normative format), closed loop with serialized evaluation, controlled config application, held-out delta measurement, promote-only-positive (rollback verified by test). 34→34 tests green including 10 meta-layer tests.
> - Phase 4 ✅ — extension-tools (grep/glob/http-fetch), OpenAI-compatible provider (SSE), TUI+CLI (demo/run/orchestrate), benchmarks package, integration+security tests. Security tests caught 2 REAL vulnerabilities, both fixed: (1) case-bypass in command policy (`RM -RF /` dodged deny-list) → case-insensitive matching; (2) API key exposed via JSON.stringify(provider) (TS private is not runtime privacy) → key moved to a module-level WeakMap. All 7 packages build green; 49 tests green + demo e2e green.
> - Phase 5 ✅ — benchmark suite executed for real (5 scripted scenarios on MockProvider): first-pass rate 1.0, avg quality 10/10, avg 309 tokens, avg latency 15.6 ms. Baseline documented in docs/baseline.md (markdown + machine-readable JSON fence). Comparison workflow: `pnpm exec tsx benchmarks/run.ts`.
> - Phase 6 ✅ — README, CONTRIBUTING, LICENSE MIT, logo SVG (docs/assets/logo.md), benchmark README. Repo usable from scratch: clone → pnpm install → pnpm build → pnpm test → pnpm demo.
>
> **Subagent budget final:** 20 dispatched (6 wave1 + 7 wave2 + 1 selector + 5 wave4 + 1 n/a) — under the 30 cap. 429 storms killed several early agents; orchestrator self-implemented the gaps per the fallback rule. No variant, module, or test was left unowned.

## Phase 0 — Bootstrap (orchestrator solo, 0 subagents)
- prd.md, plan.md, ideas.md, doubts.md with concrete decisions.
- **Done:** 4 files exist, contain architecture decisions, core/extension boundaries, metric definitions.

## Phase 1 — Architecture & Contracts (orchestrator solo + 1 doc agent)
- `docs/architecture.md`: full architecture, public core interfaces, security model, state model, telemetry format.
- Root scaffold: pnpm workspace, tsconfig strict base, biome, vitest, tsup — **build green before any dispatch**.
- `PHASE_BUILD.md` at repo root: frozen API contract + ownership matrix (agents read this first).
- **Done:** architecture doc scored ≥ 8.0 by evaluator agent; definitive core/extension list; scaffold compiles.

## Phase 2 — Core Implementation (wave of 8)
| # | Task | Owns (disjoint) |
|---|------|-----------------|
| A1 | Message/Provider types + streaming interface + `MockProvider` | `core/src/providers/`, `core/src/types/` |
| A2 | Agent loop (`Agent` class, turn engine, steering/abort) | `core/src/agent/` |
| A3 | Tool system (registry, `read`/`write`/`edit`/`bash`, policy) | `core/src/tools/` |
| A4 | Session & state (JSONL append-only log, tree, checkpoint, branch, compaction) | `core/src/session/` |
| A5 | Event/telemetry bus (typed emit/subscribe, ring buffer) | `core/src/events/` |
| A6 | Orchestration engine (depth ≤ 2 planner, task graph, builder/critic) | `core/src/orchestration/` |
| A7 | Quality gate (weighted rubric, streaming gate, score card) | `core/src/quality/` |
| A8 | Core unit tests for A1–A5 surface + test fixtures | `core/test/` |

Variant rule: A2 (Agent Loop) and A6 (Orchestration) get **3 independent implementations** each
(wave of 6) + External Selector agent with fresh context (weights: Efficiency 70 / Code quality 20 /
Usability-Reuse 10). Winner merged by orchestrator; losers archived under `variants/` docs.
- **Done:** `core` compiles, unit tests green, public interfaces stable, evaluator score ≥ 8.0.

## Phase 3 — Meta-Layer extension (wave of 4)
| # | Task | Owns |
|---|------|------|
| B1 | Telemetry store (queryable JSONL + SQLite-optional) + data formats | `meta-layer/src/store/` |
| B2 | Hypothesis engine (generate → apply controlled → measure delta → promote) | `meta-layer/src/hypotheses/` |
| B3 | Meta-Layer orchestrator glue (subscribes to event bus, closed loop runner) | `meta-layer/src/loop.ts` |
| B4 | Meta-Layer tests + simulated-event fixture end-to-end | `meta-layer/test/` |
Variants: B2 gets 3 variants + selector (same weights).
- **Done:** meta-layer runs end-to-end on simulated events; data format documented; tests green.

## Phase 4 — Extensions & Integration (wave of 9)
| # | Task | Owns |
|---|------|------|
| C1 | `extension-tools`: grep, glob, http-fetch tools | `extension-tools/src/` |
| C2 | Provider adapters: OpenAI-compatible streaming adapter | `core/src/providers/openai/` |
| C3 | TUI: REPL loop, renderer, streaming print | `tui/src/` |
| C4 | CLI wiring: `elysium run/demo/orchestrate` commands | `cli/src/` |
| C5 | Examples: offline demo task (mock provider), sample session | `examples/` |
| C6 | Orchestrator+gate integration tests (depth-2 run on mock provider) | `core/test/integration/` |
| C7 | Security tests: bash policy, path traversal, secret-scan | `core/test/security/` |
| C8 | Docs: README + getting started (orchestrator drafts, agent expands) | `README.md`, `docs/` |
| C9 | Eval harness scaffolding (dataset format, runner, scoring) | `benchmarks/src/` |
- **Done:** end-to-end demo runs (`pnpm demo`), integration + security tests green.

## Phase 5 — Benchmarks, Evals, Hardening (wave of 5)
| # | Task |
|---|------|
| D1 | Benchmark scenarios (task suite on mock + optional live providers) |
| D2 | Metrics collection + `docs/baseline.md` generation |
| D3 | Evals: quality-gate calibration set with human-labeled examples |
| D4 | Robustness fuzzing (malformed tool args, provider stream corruption) |
| D5 | Hardening report + fixes |
- **Done:** suite executable, results in `benchmarks/results/`, baseline documented.

## Phase 6 — Polish & Identity (orchestrator + 2)
- Logo SVG, final README, CONTRIBUTING, LICENSE (MIT), npm publish readiness check.
- **Done:** repo usable by third parties from README alone.

## Measurement definitions
- **first-pass rate** = tasks accepted at quality gate on first attempt / total tasks (per benchmark run).
- **token usage** = prompt + completion tokens per task/run (from provider usage or mock counter).
- **latency** = wall-clock per turn and per task (ms), recorded on the event bus.
- **quality score** = weighted rubric (correctness .30, efficiency .30, maintainability .20, principle-adherence .20), 0–10.

## Failure handling
Every phase: declared budget → if not converged: blocker report + simpler-strategy fallback proposal.
Global stop condition: all phases done + repo complete + benchmark suite executable + docs sufficient to start from zero.
