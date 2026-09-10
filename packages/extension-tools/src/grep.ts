/**
 * grep tool: recursive regex search over text files under a policy-allowed
 * root. Skips node_modules/.git/dist, symlinks, likely-binary files (NUL byte
 * sniff) and files larger than 2 MB. Emits normative tool_called telemetry.
 */
import fs from "node:fs";
import path from "node:path";
import { PathPolicyError, resolveWithin } from "@elysium/core";
import type { PathPolicy, Tool, ToolContext, ToolResult } from "@elysium/core";
import { argNumber, argString, collectFiles, err, ok, toPosixRel, toolTelemetry } from "./internal";

const DEFAULT_MAX_RESULTS = 50;
const MAX_LINE_CHARS = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SNIFF_BYTES = 8192;

interface GrepState {
  lines: string[];
  matched: number;
  skippedBinary: number;
  skippedLarge: number;
  unreadableFiles: number;
}

/** NUL-byte sniff of the first SNIFF_BYTES: the classic text vs binary probe. */
function looksBinary(fd: number, size: number): boolean {
  const len = Math.min(size, SNIFF_BYTES);
  const sniff = Buffer.alloc(len);
  const read = fs.readSync(fd, sniff, 0, len, 0);
  return sniff.subarray(0, read).includes(0);
}

function searchFile(
  absFile: string,
  relFile: string,
  regex: RegExp,
  max: number,
  state: GrepState,
  signal: AbortSignal,
): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absFile);
  } catch {
    state.unreadableFiles += 1;
    return;
  }
  if (!stat.isFile()) return;
  if (stat.size > MAX_FILE_BYTES) {
    state.skippedLarge += 1;
    return;
  }
  let content: string;
  try {
    const fd = fs.openSync(absFile, "r");
    try {
      if (looksBinary(fd, stat.size)) {
        state.skippedBinary += 1;
        return;
      }
    } finally {
      fs.closeSync(fd);
    }
    content = fs.readFileSync(absFile, "utf-8");
  } catch {
    state.unreadableFiles += 1;
    return;
  }
  const lines = content.split(/\r\n|\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (signal.aborted) throw new Error("aborted by caller signal");
    const line = lines[i];
    if (line === undefined || !regex.test(line)) continue;
    if (state.matched >= max) return;
    state.matched += 1;
    const shown = line.trim().slice(0, MAX_LINE_CHARS);
    state.lines.push(`${relFile}:${i + 1}: ${shown}`);
  }
}

async function runGrep(
  args: Record<string, unknown>,
  ctx: ToolContext,
  policy: PathPolicy,
): Promise<ToolResult> {
  const pattern = argString(args, "pattern");
  if (pattern === undefined) return err("missing required argument 'pattern'");
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`invalid regex '${pattern}': ${message}`);
  }
  const maxResults = argNumber(args, "maxResults") ?? DEFAULT_MAX_RESULTS;
  if (!Number.isInteger(maxResults) || maxResults < 1) {
    return err("'maxResults' must be a positive integer");
  }
  const target = argString(args, "path") ?? ".";
  let base: string;
  try {
    base = resolveWithin(ctx.cwd, policy, target);
  } catch (e: unknown) {
    if (e instanceof PathPolicyError) return err(`grep blocked by path policy: ${e.message}`);
    throw e;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(base);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`cannot access '${target}': ${message}`);
  }
  const state: GrepState = {
    lines: [],
    matched: 0,
    skippedBinary: 0,
    skippedLarge: 0,
    unreadableFiles: 0,
  };
  if (stat.isFile()) {
    searchFile(base, toPosixRel(path.dirname(base), base), regex, maxResults, state, ctx.signal);
  } else if (stat.isDirectory()) {
    const walk = collectFiles(base, ctx.signal);
    const files = walk.files.sort();
    for (const file of files) {
      if (state.matched >= maxResults) break;
      if (ctx.signal.aborted) throw new Error("aborted by caller signal");
      searchFile(file, toPosixRel(base, file), regex, maxResults, state, ctx.signal);
    }
  } else {
    return err(`'${target}' is neither a regular file nor a directory`);
  }
  const details = {
    base,
    matched: state.matched,
    capReached: state.matched >= maxResults,
    skippedBinary: state.skippedBinary,
    skippedLarge: state.skippedLarge,
    unreadableFiles: state.unreadableFiles,
  };
  if (state.lines.length === 0) {
    return ok(`no matches for /${pattern}/ under ${base}`, details);
  }
  return ok(state.lines.join("\n"), details);
}

export function createGrepTool(policy: PathPolicy): Tool {
  return {
    name: "grep",
    description:
      "Search text files recursively with a regular expression. Returns matches as " +
      "'relativePath:lineNo: line'. Skips node_modules, .git, dist, symlinks, binaries and files over 2 MB.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression source (JavaScript syntax)" },
        path: { type: "string", description: "File or directory to search (default '.')" },
        maxResults: {
          type: "number",
          description: "Maximum number of matching lines (default 50)",
        },
      },
      required: ["pattern"],
    },
    async execute(args, ctx) {
      const t0 = Date.now();
      let isError = false;
      try {
        const result = await runGrep(args, ctx, policy);
        isError = result.isError;
        return result;
      } catch (e: unknown) {
        isError = true;
        const message = e instanceof Error ? e.message : String(e);
        return err(`grep failed: ${message}`);
      } finally {
        toolTelemetry(ctx.emit, "grep", Date.now() - t0, isError);
      }
    },
  };
}
