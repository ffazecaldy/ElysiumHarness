/**
 * Agent loop — Variant C (functional state machine).
 * Public seam: the `Agent` driver class plus the pure state-machine surface
 * (`createAgentState` / `stepTurn`) for provider-free testing.
 */

export {
  DEFAULT_MAX_TURNS,
  Agent,
  createAgentState,
  stepTurn,
} from "./agent";
export type {
  AgentOptions,
  AgentState,
  ToolExecutor,
  TurnResult,
} from "./agent";
