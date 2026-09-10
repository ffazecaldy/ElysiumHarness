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
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const regexCache = new Map<string, RegExp>();

function cachedRegex(source: string): RegExp {
  const found = regexCache.get(source);
  if (found) return found;
  const compiled = new RegExp(source);
  regexCache.set(source, compiled);
  return compiled;
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
  const real = realpath(resolved);
  for (const root of policy.allowedRoots) {
    if (isInside(realpath(root), real)) {
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
  const trimmed = command.trim();
  for (const pattern of policy.deniedCommands ?? []) {
    if (cachedRegex(pattern).test(trimmed)) {
      return { allowed: false, warn: false };
    }
  }
  for (const pattern of policy.warnCommands ?? []) {
    if (cachedRegex(pattern).test(trimmed)) {
      return { allowed: true, warn: true };
    }
  }
  return { allowed: true, warn: false };
}
