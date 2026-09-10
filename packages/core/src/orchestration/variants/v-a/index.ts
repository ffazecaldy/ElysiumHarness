/**
 * Variant A orchestration surface — plan-graph executor (depth ≤ 2).
 */

export { Orchestrator, type OrchestratorOptions } from "./orchestrator";

// Convenience re-exports of the frozen orchestration contract this variant implements.
export type {
  CriticVerdict,
  OrchestrationPlan,
  OrchestrationReport,
  SpawnFn,
  SubagentResult,
  SubagentTask,
  SubtaskReport,
} from "../../../types/orchestration";
