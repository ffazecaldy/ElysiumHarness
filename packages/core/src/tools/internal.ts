/** Shared helpers for builtin tools: arg coercion, results, telemetry. */
import type { HarnessEvent } from "../types/events";
import type { ToolResult } from "../types/tools";

export function argString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

export function argNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function argBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  return typeof v === "boolean" ? v : undefined;
}

export function ok(content: string, details?: unknown): ToolResult {
  return details === undefined ? { content, isError: false } : { content, isError: false, details };
}

export function err(content: string): ToolResult {
  return { content, isError: true };
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function telemetry(
  emit: (event: HarnessEvent) => void,
  tool: string,
  durationMs: number,
  isError: boolean,
): void {
  emit({
    type: "tool_called",
    timestamp: nowIso(),
    data: { tool, durationMs, isError },
  });
}
