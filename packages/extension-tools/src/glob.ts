/**
 * glob tool: minimal glob supporting double-star, star and question-mark
 * wildcards via conversion to a RegExp matched against forward-slash relative
 * paths under a policy-allowed root. Returns sorted relative paths, capped at
 * 200. Emits tool_called telemetry.
 */
import fs from "node:fs";
import { PathPolicyError, resolveWithin } from "@elysium/core";
import type { PathPolicy, Tool, ToolContext, ToolResult } from "@elysium/core";
import { argString, collectFiles, err, ok, toPosixRel, toolTelemetry } from "./internal";

const MAX_RESULTS = 200;

function escapeChar(c: string): string {
  return /[\\^$.+()|[\]{}]/.test(c) ? `\\${c}` : c;
}

/**
 * Convert a glob pattern to an anchored RegExp over relative paths.
 * A double-star spans directory levels (a trailing double-star-slash may match
 * zero levels), a single star matches within one segment, and a question mark
 * matches a single non-separator character. Backslashes in the pattern are
 * normalized to forward slashes (Windows-safe).
 */
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.split("\\").join("/");
  let source = "";
  let i = 0;
  while (i < normalized.length) {
    const c = normalized.charAt(i);
    if (c === "*") {
      let stars = 0;
      while (normalized.charAt(i) === "*") {
        stars += 1;
        i += 1;
      }
      if (stars >= 2 && normalized.charAt(i) === "/") {
        i += 1;
        source += "(?:.*/)?";
      } else if (stars >= 2) {
        source += ".*";
      } else {
        source += "[^/]*";
      }
    } else if (c === "?") {
      source += "[^/]";
      i += 1;
    } else {
      source += escapeChar(c);
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

async function runGlob(
  args: Record<string, unknown>,
  ctx: ToolContext,
  policy: PathPolicy,
): Promise<ToolResult> {
  const pattern = argString(args, "pattern");
  if (pattern === undefined || pattern.trim() === "") {
    return err("missing required argument 'pattern'");
  }
  const cwd = argString(args, "cwd") ?? ".";
  let base: string;
  try {
    base = resolveWithin(ctx.cwd, policy, cwd);
  } catch (e: unknown) {
    if (e instanceof PathPolicyError) return err(`glob blocked by path policy: ${e.message}`);
    throw e;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(base);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`cannot access '${cwd}': ${message}`);
  }
  if (!stat.isDirectory()) {
    return err(`'${cwd}' is not a directory`);
  }
  let regex: RegExp;
  try {
    regex = globToRegExp(pattern);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return err(`invalid glob pattern '${pattern}': ${message}`);
  }
  if (ctx.signal.aborted) throw new Error("aborted by caller signal");
  const walk = collectFiles(base, ctx.signal);
  const matches = walk.files
    .map((file) => toPosixRel(base, file))
    .sort()
    .filter((rel) => regex.test(rel));
  const capReached = matches.length > MAX_RESULTS;
  const shown = matches.slice(0, MAX_RESULTS);
  const details = { base, matched: matches.length, capReached };
  if (shown.length === 0) {
    return ok(`no matches for pattern '${pattern}' under ${base}`, details);
  }
  return ok(shown.join("\n"), details);
}

export function createGlobTool(policy: PathPolicy): Tool {
  return {
    name: "glob",
    description:
      "Find files by glob pattern (double-star, star, question mark). Matches against " +
      "relative paths under cwd and returns them sorted. Brace expansion is not supported.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. src/**/*.ts" },
        cwd: { type: "string", description: "Directory to search (default .)" },
      },
      required: ["pattern"],
    },
    async execute(args, ctx) {
      const t0 = Date.now();
      let isError = false;
      try {
        const result = await runGlob(args, ctx, policy);
        isError = result.isError;
        return result;
      } catch (e: unknown) {
        isError = true;
        const message = e instanceof Error ? e.message : String(e);
        return err(`glob failed: ${message}`);
      } finally {
        toolTelemetry(ctx.emit, "glob", Date.now() - t0, isError);
      }
    },
  };
}
