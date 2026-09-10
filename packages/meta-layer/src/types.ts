/**
 * Meta-Layer data formats — NORMATIVE (docs/architecture.md §5/§6).
 * Telemetry records are core HarnessEvents persisted verbatim as JSONL.
 * Hypotheses follow the explicit JSON shape below.
 */
import type { HarnessEvent, HarnessEventType } from "@elysium/core";

export type MetricName =
  | "first_pass_rate"
  | "retry_rate"
  | "avg_task_latency_ms"
  | "token_efficiency"
  | "error_rate"
  | string;

export interface Observation {
  metric: MetricName;
  value: number;
  /** Number of tasks in the aggregation window. */
  window: number;
}

export type HypothesisChangeKind =
  | "retry_policy"
  | "decomposition_granularity"
  | "tool_ordering"
  | "max_concurrency";

export interface HypothesisChange {
  kind: HypothesisChangeKind;
  from: Record<string, unknown>;
  to: Record<string, unknown>;
}

export type HypothesisStatus = "proposed" | "applied" | "promoted" | "rejected";

export interface Hypothesis {
  id: string;
  observation: Observation;
  change: HypothesisChange;
  expectedEffect: string;
  status: HypothesisStatus;
  /** Measured delta (after - before); null until measured. */
  delta: number | null;
}

/** Events the Meta-Layer persists (verbatim HarnessEvent JSONL). */
export type TelemetryRecord = HarnessEvent;

export interface TelemetryQuery {
  runId?: string;
  taskId?: string;
  type?: HarnessEventType;
  since?: string;
  until?: string;
}
