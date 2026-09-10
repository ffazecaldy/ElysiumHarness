/**
 * Quality gate types — weighted multi-dimension scoring.
 * FROZEN CONTRACT — changes require orchestrator approval.
 */

export interface RubricCriterion {
  name: string;
  /** Relative weight; normalized so sum(weights) === 1. */
  weight: number;
  /** Instruction for the judge (human, structural, or LLM). */
  instruction: string;
}

export interface Rubric {
  id: string;
  dimensions: RubricCriterion[];
  /** Minimum weighted score (0-10) to accept. */
  threshold: number;
}

export interface GateArtifact {
  taskId?: string;
  kind: "code" | "text" | "plan";
  content: string;
  /** Explicit acceptance criteria the artifact must cover. */
  criteria?: string[];
}

export interface QualityDimensionScore {
  name: string;
  weight: number;
  /** 0-10 */
  score: number;
  reason: string;
}

export interface QualityScore {
  dimensions: QualityDimensionScore[];
  /** Weighted mean, 0-10. */
  weighted: number;
  passed: boolean;
  /** Always populated on failure; targeted feedback for retries. */
  reasons: string[];
}

export type JudgeFn = (artifact: GateArtifact, rubric: Rubric) => Promise<QualityScore>;

/** Default build-time rubric weights (correctness 30 / efficiency 30 / maintainability 20 / principles 20). */
export const DEFAULT_RUBRIC_WEIGHTS = {
  correctness: 0.3,
  efficiency: 0.3,
  maintainability: 0.2,
  principleAdherence: 0.2,
} as const;
