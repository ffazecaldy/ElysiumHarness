/**
 * Shared helpers for extension tools: argument coercion, results, telemetry,
 * and a policy-agnostic file walker shared by grep and glob. Mirrors
 * core/src/tools/internal.ts, which is not part of the public @elysium/core
 * surface.
 */
import fs from "node:fs";
import path from "node:path";
import type { HarnessEvent, ToolResult } from "@elysium/core";

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

export function ok(content: string, details?: unknown): ToolResult {
  return details === undefined ? { content, isError: false } : { content, isError: false, details };
}

export function err(content: string): ToolResult {
  return { content, isError: true };
}

/** Emit the normative tool_called telemetry event (data: {tool, durationMs, isError}). */
export function toolTelemetry(
  emit: (event: HarnessEvent) => void,
  tool: string,
  durationMs: number,
  isError: boolean,
): void {
  emit({
    type: "tool_called",
    timestamp: new Date().toISOString(),
    data: { tool, durationMs, isError },
  });
}

/** Forward-slash relative path, stable across platforms (Windows-safe). */
export function toPosixRel(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join("/");
}

/** Directory names pruned by every recursive walk in this package. */
export const SKIP_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist"]);

export interface WalkResult {
  files: string[];
  skippedSymlinks: number;
  unreadableDirs: number;
}

/**
 * Iteratively collect regular files under `root`, pruning SKIP_DIRS and never
 * following symlinks (a symlinked file or directory could escape the policy
 * roots). Unreadable directories are counted, not fatal.
 */
export function collectFiles(root: string, signal: AbortSignal): WalkResult {
  const files: string[] = [];
  let skippedSymlinks = 0;
  let unreadableDirs = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (signal.aborted) throw new Error("aborted by caller signal");
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadableDirs += 1;
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name.toLowerCase())) stack.push(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return { files, skippedSymlinks, unreadableDirs };
}
