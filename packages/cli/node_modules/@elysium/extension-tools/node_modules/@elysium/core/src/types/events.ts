/**
 * Typed event / telemetry bus types.
 * FROZEN CONTRACT — changes require orchestrator approval.
 */

export type HarnessEventType =
  | "task_started"
  | "task_ended"
  | "turn_started"
  | "turn_ended"
  | "tool_called"
  | "token_usage"
  | "latency"
  | "quality_evaluated"
  | "error"
  | "custom";

export interface HarnessEvent<T = Record<string, unknown>> {
  type: HarnessEventType;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  /** Identifies a top-level agent run. */
  runId?: string;
  /** Identifies an orchestration subtask when applicable. */
  taskId?: string;
  data: T;
}

export type EventHandler = (event: HarnessEvent) => void;
