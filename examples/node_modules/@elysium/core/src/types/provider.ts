/**
 * LLM provider abstraction — multi-provider streaming interface.
 * FROZEN CONTRACT — changes require orchestrator approval.
 */
import type { JsonSchema } from "./content";
import type { AgentMessage, AssistantMessage } from "./messages";

export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argumentsDelta: string }
  /** Terminal event: fully assembled assistant message (must include usage when known). */
  | { type: "done"; message: AssistantMessage }
  | { type: "error"; error: Error };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface LlmRequest {
  systemPrompt: string;
  messages: AgentMessage[];
  tools: ToolDefinition[];
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: string;
  /** Streams a single completion. Must terminate with `done` or `error` exactly once. */
  stream(request: LlmRequest): AsyncIterable<StreamEvent>;
}

// --- Deterministic scripted provider (tests / benchmarks / offline demo) ---

export interface ScriptedToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** One scripted model turn: either text and/or tool calls. */
export interface ScriptedTurn {
  text?: string;
  toolCalls?: ScriptedToolCall[];
  usage?: TokenUsageLike;
}

export interface TokenUsageLike {
  inputTokens: number;
  outputTokens: number;
}
