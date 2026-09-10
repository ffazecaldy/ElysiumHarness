/**
 * Benchmark + eval suite types (extension-local, not part of the frozen core).
 * Measurement semantics follow plan.md §Measurement.
 */
import type { ScriptedTurn } from "@elysium/core";

/** A single scripted benchmark task: prompt (description), mock script, and acceptance criteria. */
export interface BenchmarkCase {
  /** Unique, stable scenario identifier (e.g. "file-summary-basic"). */
  id: string;
  /** Human-readable task description; also used as the user prompt for the agent. */
  description: string;
  /** Deterministic provider script replayed by MockProvider for this case. */
  script: ScriptedTurn[];
  /** Acceptance criteria the final assistant text must cover (substring match, case-insensitive). */
  criteria: string[];
}

/** Token totals for one benchmark case (summed across turns, and across attempts when retried). */
export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
}

/** Result of running one benchmark case. */
export interface CaseResult {
  caseId: string;
  /** True only when the quality score reached the first-pass threshold on attempt 1. */
  firstPass: boolean;
  tokens: TokenTotals;
  /** Wall-clock milliseconds for the whole case (all attempts included). */
  latencyMs: number;
  /** Weighted quality score (0-10) from the quality gate on the final attempt. */
  qualityScore: number;
  /** Number of attempts consumed (1 or 2; the runner retries once at most). */
  attempts: number;
}

/** Aggregate result of one full benchmark run. */
export interface RunSummary {
  startedAt: string;
  completedAt: string;
  cases: CaseResult[];
  /** firstPass count / total cases, rounded to 2 decimals. */
  firstPassRate: number;
  /** Mean total tokens (input + output) per case, rounded to 2 decimals. */
  avgTokens: number;
  /** Mean wall-clock latency per case in ms, rounded to 2 decimals. */
  avgLatencyMs: number;
  /** Mean quality score per case, rounded to 2 decimals. */
  avgQuality: number;
}
