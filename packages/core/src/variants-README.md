# Variant archives

Selected by the External Selector (fresh-context, weights: efficiency 70 / code quality 20 / usability 10).

- `agent/variants/v-b` = WINNER (promoted to `agent/agent.ts`)
- `agent/variants/v-a`, `v-c` = alternates, kept for reference/benchmarking
- `orchestration/variants/v-a` = WINNER (promoted to `orchestration/orchestrator.ts`)
- `orchestration/variants/v-b` = alternate (DQ risk: emits a synthetic `repair_scheduled` status inside `task_ended` events)
- `orchestration/variants/v-c` = alternate

Do not import from this directory in production code; canonical paths are
`@elysium/core` barrel exports only.
