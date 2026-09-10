/**
 * Message types — the harness-native conversation representation.
 * FROZEN CONTRACT — changes require orchestrator approval.
 */
import type { ToolCallPart } from "./content";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type StopReason = "end_turn" | "tool_use" | "aborted" | "error";

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  text: string;
  toolCalls: ToolCallPart[];
  stopReason: StopReason;
  usage?: TokenUsage;
}

export interface ToolResultMessage {
  role: "tool_result";
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
  /** Optional structured payload (tool-specific). Never sent to the provider verbatim. */
  details?: unknown;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

export function isUserMessage(m: AgentMessage): m is UserMessage {
  return m.role === "user";
}
export function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
  return m.role === "assistant";
}
export function isToolResultMessage(m: AgentMessage): m is ToolResultMessage {
  return m.role === "tool_result";
}
