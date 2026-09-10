/**
 * Baseline persistence + comparison for benchmark runs.
 *
 * A baseline file is Markdown: a human-readable summary table plus metadata,
 * embedding the full RunSummary as a fenced ```json block. readBaseline()
 * parses that fence back — write/read round-trips losslessly.
 */
import fs from "node:fs";
import path from "node:path";
import type { CaseResult, RunSummary } from "./types";

const JSON_FENCE_OPEN = "```json";
const FENCE_CLOSE = "```";

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Regression = the metric moved in the wrong direction beyond 5% of the baseline value. */
export interface ComparisonResult {
  firstPassRateDelta: number;
  avgTokensDelta: number;
  avgLatencyDelta: number;
  avgQualityDelta: number;
  regressions: string[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isValidSummary(value: unknown): value is RunSummary {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.startedAt === "string" &&
    typeof v.completedAt === "string" &&
    typeof v.firstPassRate === "number" &&
    typeof v.avgTokens === "number" &&
    typeof v.avgLatencyMs === "number" &&
    typeof v.avgQuality === "number" &&
    Array.isArray(v.cases)
  );
}

/** Write a baseline markdown file: metadata + summary table + embedded JSON fence. */
export function writeBaseline(filePath: string, summary: RunSummary): void {
  const lines: string[] = [
    "# Elysium Harness — Benchmark Baseline",
    "",
    `- **Started at:** ${summary.startedAt}`,
    `- **Completed at:** ${summary.completedAt}`,
    `- **Cases:** ${summary.cases.length}`,
    "",
    "## Summary",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| First-pass rate | ${summary.firstPassRate} |`,
    `| Avg tokens | ${summary.avgTokens} |`,
    `| Avg latency (ms) | ${summary.avgLatencyMs} |`,
    `| Avg quality | ${summary.avgQuality} |`,
    "",
    "## Per-case results",
    "",
    "| Case | First pass | Input tokens | Output tokens | Latency (ms) | Quality | Attempts |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const c of summary.cases) {
    lines.push(
      `| ${c.caseId} | ${c.firstPass ? "yes" : "no"} | ${c.tokens.inputTokens} | ${c.tokens.outputTokens} | ${c.latencyMs} | ${c.qualityScore} | ${c.attempts} |`,
    );
  }
  lines.push(
    "",
    "## Machine-readable snapshot",
    "",
    "The fenced JSON block below is the canonical baseline record; `readBaseline()` parses it back.",
    "",
    JSON_FENCE_OPEN,
    JSON.stringify(summary, null, 2),
    FENCE_CLOSE,
    "",
  );
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, lines.join("\n"), "utf-8");
}

/**
 * Read a baseline file written by writeBaseline(). Returns null when the file
 * does not exist. Throws on a malformed file (missing or unparsable JSON fence).
 */
export function readBaseline(filePath: string): RunSummary | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf-8");
  const open = raw.indexOf(JSON_FENCE_OPEN);
  if (open < 0) {
    throw new Error(`baseline file '${filePath}' contains no ${JSON_FENCE_OPEN} fence`);
  }
  const jsonStart = raw.indexOf("\n", open);
  if (jsonStart < 0) {
    throw new Error(`baseline file '${filePath}' has a malformed ${JSON_FENCE_OPEN} fence`);
  }
  const close = raw.indexOf(FENCE_CLOSE, jsonStart);
  if (close < 0) {
    throw new Error(`baseline file '${filePath}' fence is not closed`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(jsonStart + 1, close));
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`baseline file '${filePath}' contains invalid JSON: ${message}`);
  }
  if (!isValidSummary(parsed)) {
    throw new Error(`baseline file '${filePath}' JSON does not match the RunSummary shape`);
  }
  return parsed;
}

/** Compare the current run against a baseline; deltas are current - baseline. */
export function compare(current: RunSummary, baseline: RunSummary): ComparisonResult {
  const firstPassRateDelta = round2(current.firstPassRate - baseline.firstPassRate);
  const avgTokensDelta = round2(current.avgTokens - baseline.avgTokens);
  const avgLatencyDelta = round2(current.avgLatencyMs - baseline.avgLatencyMs);
  const avgQualityDelta = round2(current.avgQuality - baseline.avgQuality);

  const regressions: string[] = [];
  const thresholdRatio = 0.05;
  const regressed = (metric: string, delta: number, base: number): boolean => {
    if (!isFiniteNumber(base) || base === 0) return delta < 0 ? false : false;
    const drift = delta / Math.abs(base);
    return Math.abs(drift) > thresholdRatio;
  };
  // Wrong direction per metric: first-pass rate and quality go down, tokens and latency go up.
  if (regressed("firstPassRate", firstPassRateDelta, baseline.firstPassRate) && firstPassRateDelta < 0) {
    regressions.push(
      `firstPassRate regressed: ${baseline.firstPassRate} -> ${current.firstPassRate} (delta ${firstPassRateDelta})`,
    );
  }
  if (regressed("avgTokens", avgTokensDelta, baseline.avgTokens) && avgTokensDelta > 0) {
    regressions.push(
      `avgTokens regressed: ${baseline.avgTokens} -> ${current.avgTokens} (delta ${avgTokensDelta})`,
    );
  }
  if (regressed("avgLatencyMs", avgLatencyDelta, baseline.avgLatencyMs) && avgLatencyDelta > 0) {
    regressions.push(
      `avgLatencyMs regressed: ${baseline.avgLatencyMs} -> ${current.avgLatencyMs} (delta ${avgLatencyDelta})`,
    );
  }
  if (regressed("avgQuality", avgQualityDelta, baseline.avgQuality) && avgQualityDelta < 0) {
    regressions.push(
      `avgQuality regressed: ${baseline.avgQuality} -> ${current.avgQuality} (delta ${avgQualityDelta})`,
    );
  }
  return { firstPassRateDelta, avgTokensDelta, avgLatencyDelta, avgQualityDelta, regressions };
}

/** Re-exported for consumers that iterate case rows of a baseline. */
export type { CaseResult, RunSummary } from "./types";
