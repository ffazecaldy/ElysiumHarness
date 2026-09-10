/**
 * Security policy resolution: path containment + command evaluation.
 * Path checks are symlink-aware (real path when the file exists).
 */
import fs from "node:fs";
import path from "node:path";
import type { PathPolicy } from "../types/tools";

export class PathPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  // Escape detection must anchor the ".." segment: a file literally named
  // "..data.txt" inside the root is NOT an escape.
  if (rel === ".." || rel.startsWith(`..${path.sep}`)) return false;
  return true;
}

/**
 * Real path of `p`. Nonexistent paths (ENOENT/ENOTDIR — e.g. a file that is
 * about to be created) fall back to the lexical resolution; any other OS
 * failure (EACCES, EPERM, ENAMETOOLONG, ...) must not be swallowed silently:
 * it escalates to PathPolicyError so callers treat it as denied.
 */
function realpathOrDenied(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      throw new PathPolicyError(`cannot resolve real path for '${p}': ${describeError(e)}`);
    }
  }
  try {
    return path.resolve(p);
  } catch (e: unknown) {
    throw new PathPolicyError(`cannot resolve path for '${p}': ${describeError(e)}`);
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const regexCache = new Map<string, RegExp>();

function cachedRegex(source: string, kind: "denied" | "warn"): RegExp | undefined {
  const cacheKey = `${kind}:${source}`;
  const found = regexCache.get(cacheKey);
  if (found) return found;
  try {
    // Case-insensitive: shell commands vary in casing (RM -RF must match rm -rf).
    const compiled = new RegExp(source, "i");
    regexCache.set(cacheKey, compiled);
    return compiled;
  } catch {
    // Invalid policy data: return undefined and let the caller fail safe
    // (denied patterns deny, warn patterns skip). No crash, no regexCache pollution.
    return undefined;
  }
}

/**
 * Resolve `targetPath` against `ctxCwd` and verify the real resolved path
 * lies inside one of `policy.allowedRoots`. Returns the resolved (non-real)
 * path for I/O use. Throws PathPolicyError on containment violation.
 */
export function resolveWithin(ctxCwd: string, policy: PathPolicy, targetPath: string): string {
  if (policy.allowedRoots.length === 0) {
    throw new PathPolicyError("no allowed roots configured");
  }
  const resolved = path.resolve(ctxCwd, targetPath);
  // Both containment inputs go through the guarded resolver: a root that
  // cannot be realpath'ed (e.g. EACCES on a parent dir) is denied, not trusted.
  const real = realpathOrDenied(resolved);
  for (const root of policy.allowedRoots) {
    if (isInside(realpathOrDenied(root), real)) {
      return resolved;
    }
  }
  throw new PathPolicyError(
    `path '${targetPath}' resolves to '${real}' which is outside the allowed roots`,
  );
}

export interface CommandEvaluation {
  allowed: boolean;
  warn: boolean;
}

/** Match a command against denied/warn regex source strings (trimmed command). */
export function evaluateCommand(policy: PathPolicy, command: string): CommandEvaluation {
  // Fail-closed policy semantics: any invalid denied pattern denies the
  // command outright — bad policy data must never widen what is allowed.
  const invalidDenied = policy.deniedCommands?.some((s) => !cachedRegex(s, "denied")) ?? false;
  if (invalidDenied) {
    return { allowed: false, warn: false };
  }
  const trimmed = command.trim();
  for (const pattern of policy.deniedCommands ?? []) {
    if (cachedRegex(pattern, "denied")?.test(trimmed)) {
      return { allowed: false, warn: false };
    }
  }
  for (const pattern of policy.warnCommands ?? []) {
    if (cachedRegex(pattern, "warn")?.test(trimmed)) {
      return { allowed: true, warn: true };
    }
  }
  return { allowed: true, warn: false };
}
