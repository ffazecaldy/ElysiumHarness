/**
 * Content-level types shared across the whole harness.
 * FROZEN CONTRACT — changes require orchestrator approval.
 */

/** Minimal JSON-Schema subset used for tool parameter declarations. */
export type JsonSchema = Record<string, unknown>;

export interface TextPart {
  type: "text";
  text: string;
}

/** A tool call requested by the model. */
export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ContentPart = TextPart | ToolCallPart;
