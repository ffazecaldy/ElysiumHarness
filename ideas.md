# Ideas — Elysium Harness

Collected during Phase 0. Status: `adopted` / `rejected` / `deferred` — with reasons.

## Adopted
1. **Pi-style turn snapshot** — every LLM turn resolves from an immutable snapshot (messages, model, tools, stream options); mid-turn config changes affect only the next turn. Prevents in-flight mutation bugs.
2. **Session as append-only tree** — `id`/`parentId` JSONL entries; branch = new leaf; compaction = summary entry that prunes context projection, never rewrites history.
3. **Context projection separated from storage** — storage keeps everything; `buildContext()` projects what the model sees (compaction-aware). Enables lossless replay + measurement.
4. **Depth-2 orchestration by construction** — the orchestrator type system only allows spawning leaf subagents; depth is checked at plan-graph build time, not by convention.
5. **Quality gate as a tool-consuming component** — the gate subscribes to the event bus and evaluates structured artifacts (code diffs, summaries); accept/reject always returns a reason list, so retries are targeted.
6. **Mock provider as first-class citizen** — deterministic scripted provider for tests and benchmarks; all offline criteria (R11) depend on it.
7. **Telemetry as typed events, not logs** — `TaskStarted`, `TaskEnded`, `ToolCalled`, `TokenUsage`, `LatencyMeasured`, `QualityEvaluated`, `ErrorRaised` — all with run/task ids; Meta-Layer is just a subscriber.
8. **Hypothesis format** — `{id, observation, change, expectedEffect, status: proposed|applied|promoted|rejected, delta}` — promotion only if delta positive on a held-out re-run.
9. **Anti-slop rubric with numeric thresholds** — 6 criteria 0–10 (concreteness, specificity, no-filler, actionability, principle-adherence, code quality); mean ≥ 8.0 to accept; used by gate and by evaluator agents during the build itself.
10. **Fresh-context evaluation** — evaluators/critics receive only: module goal, public interfaces, constraints, acceptance criteria, and the candidate output. Never the builder's reasoning history.
11. **Variant policy restricted** — 3-variant racing ONLY for Agent Loop, Orchestration engine, Meta-Layer hypothesis engine. Everything else: single implementation + standard review.
12. **Biome over ESLint+Prettier** — single fast toolchain; fewer moving parts in a monorepo.

## Rejected
- Plugin loader with dynamic `import()` of arbitrary packages in core (security surface; extensions link statically for v1).
- SQLite as the default telemetry store (JSONL default; SQLite optional adapter later — keeps core dependency-free).
- Full TUI with differential rendering like Pi's (v1: streaming REPL; defer diff-rendering).
- LSP integration, MCP client/server (deferred — extension candidates, not core).

## Deferred (backlog)
- RPC mode over stdio (Pi-style) for non-Node integrations.
- Session export to HTML.
- Cost tracking per provider with live pricing tables.
- Swarmloop-style "gauntlet" runtime mode as a packaged orchestration profile (data-driven config of the same engine).
