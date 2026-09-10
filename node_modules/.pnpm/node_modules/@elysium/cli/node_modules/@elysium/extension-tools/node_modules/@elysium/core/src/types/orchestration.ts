/**
 * Hierarchical orchestration types — depth ≤ 2 BY CONSTRUCTION.
 * A plan carries exactly one level of subtasks; a SubagentResult cannot carry a plan,
 * so a spawned subagent has no API to spawn further.
 * FROZEN CONTRACT — changes require orchestrator approval.
 */
import type { QualityScore } from "./quality";

export interface SubagentTask {
  id: string;
  goal: string;
  /** Fresh context handed to the subagent (it sees NOTHING else). */
  context?: string;
  acceptanceCriteria?: string[];
}

export interface SubagentResult {
  taskId: string;
  status: "pass" | "fail" | "partial";
  summary: string;
  /** Artifact identifiers (paths, ids) produced by the subagent. */
  artifacts: string[];
  score?: QualityScore;
}

/** Hard-typed depth limit: only the literal 2 is assignable. */
export type MaxDepth = 2;

export interface CriticConfig {
  enabled: boolean;
  /** Repair rounds after critic gaps. Default 1. */
  repairRounds?: number;
}

export interface OrchestrationPlan {
  goal: string;
  maxDepth: MaxDepth;
  subtasks: SubagentTask[];
  critic?: CriticConfig;
}

export interface CriticVerdict {
  passed: boolean;
  gaps: string[];
}

export interface SubtaskReport {
  task: SubagentTask;
  result: SubagentResult;
  critic?: CriticVerdict;
}

export interface OrchestrationReport {
  goal: string;
  completedAt: string;
  subtasks: SubtaskReport[];
  allPassed: boolean;
  totalDurationMs: number;
}

/** The single seam an orchestrator uses to execute a subtask. */
export type SpawnFn = (task: SubagentTask) => Promise<SubagentResult>;
