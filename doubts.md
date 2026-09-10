# Doubts — Elysium Harness

Open questions and risks. Each entry lists mitigation. Resolved items move to `ideas.md` with the decision.

## Open
1. **Pi compatibility surface** — do we mirror Pi's exact API shapes (`AgentTool` with typebox params, `streamFn`) or define our own? *Working decision:* our own minimal shapes, Pi-inspired naming; no hard dependency on Pi packages. Revisit in Phase 1 review.
2. **Quality gate subjectivity** — the rubric requires an LLM judge for live runs; offline (mock provider) the gate can only check structure/completeness. *Mitigation:* two gate profiles — `structural` (deterministic, offline) and `llm-judge` (live, optional provider call). Benchmarks state which profile was used.
3. **Depth-2 limit rigidity** — real orchestrations sometimes want fan-out-of-fan-out. *Decision:* depth ≤ 2 is a hard product constraint (R5); escaping it requires a new top-level run, which keeps the graph auditable.
4. **Bash tool on Windows** — PowerShell vs POSIX divergence. *Mitigation:* bash tool spawns the platform shell; policy layer normalizes dangerous patterns cross-platform; security tests run on both path styles.
5. **Meta-Layer self-modification scope** — hypotheses that change orchestration parameters can compound errors. *Mitigation:* hypotheses are config deltas (retry counts, decomposition granularity, tool ordering), never code patches; promotion requires positive delta on held-out re-run.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Subagent outputs conflict on shared types | med | high | frozen contract (`PHASE_BUILD.md`) + disjoint ownership; shared types land before wave |
| Variant selection adds 6 agents' cost for 2 components | certain | med | accepted by user budget (30 total); losers archived, not deleted |
| Free-tier provider 5xx storms mid-batch | med | med | waves of ≤ 12; timeout ≠ failure audit; re-dispatch gaps only |
| Windows path/CRLF friction in tests | high | low | pathstr helpers in core; `.gitattributes` `* text=auto eol=lf` |
| Benchmarks on mock provider measure the wrong thing | med | med | baseline doc separates offline (deterministic) vs live (provider-dependent) numbers |

## Resolved
- (Phase 0) pnpm not installed → installed globally via npm 12.3.4.
- (Phase 0) Repo remote exists with placeholder README → cloned, building in place.
- (Phase 1) pnpm 12 blocks dependency build scripts by default → declared `pnpm.onlyBuiltDependencies` (biome, esbuild) in root package.json; vitest/biome verified working without postinstall anyway.
- (Phase 2) Parallel variants initially assigned the same file path → resolved mid-flight via steer to per-variant dirs (`variants/v-x/`); one child file was accidentally overwritten by the orchestrator and restored from git commit `eaea84f` (no child work lost).
- (Phase 2) Provider 429 storms with 13 concurrent children → waves reduced to ≤ 5; orchestrator self-implements dead-agent modules (user rule: after two blocked rounds, do it yourself).
- (Phase 3) Meta-Layer auto-evaluation raced test assertions (fire-and-forget) → serialized evaluation chain + `whenIdle()`; engine had a double-push bug (make() pushed + call site pushed again) → fixed, root-caused via direct tsx execution.
- (Phase 3) vitest alias subpath resolution semantics → intra-package relative imports in meta-layer tests; aliases kept for exact package entries only.
