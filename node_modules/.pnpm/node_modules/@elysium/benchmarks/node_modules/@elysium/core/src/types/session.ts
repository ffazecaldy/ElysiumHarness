/**
 * Session persistence types — append-only tree model.
 * FROZEN CONTRACT — changes require orchestrator approval.
 */
import type { AgentMessage, AssistantMessage, ToolResultMessage, UserMessage } from "./messages";

export type SessionEntryData =
  | { kind: "user"; message: UserMessage }
  | { kind: "assistant"; message: AssistantMessage }
  | { kind: "tool_result"; message: ToolResultMessage }
  /** Compaction marker: summarizes the listed entries. Never deletes them. */
  | { kind: "summary"; text: string; coversEntryIds: string[] }
  | { kind: "meta"; label: string; data?: unknown };

export interface SessionEntry {
  id: string;
  parentId: string | null;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  data: SessionEntryData;
}

export interface CompactionOptions {
  /** Summarizer used to produce the summary entry text. */
  summarizer?: (messages: AgentMessage[]) => Promise<string>;
  /** Keep at least this many recent messages un-compacted. Default 4. */
  keepMessages?: number;
}

export interface CompactionResult {
  summaryEntryId: string;
  coveredCount: number;
}

/** A checkpoint IS a leaf pointer — append-only storage makes every state reproducible. */
export interface Checkpoint {
  entryId: string | null;
  entryCount: number;
}
