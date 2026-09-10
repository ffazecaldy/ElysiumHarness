/**
 * @elysium/benchmarks — benchmark + eval suite (extension).
 * Measures first-pass rate, token usage, latency, quality score;
 * compares against a markdown baseline (write + read + compare).
 */
export const BENCHMARKS_VERSION = "0.1.0";

export type {
  BenchmarkCase,
  CaseResult,
  RunSummary,
  TokenTotals,
} from "./types";
export {
  BenchmarkCaseError,
  BenchmarkRunner,
} from "./runner";
export type { TaskRunnerOptions } from "./runner";
export { createStandardScenarios } from "./scenarios";
export {
  compare,
  readBaseline,
  writeBaseline,
} from "./baseline";
export type { ComparisonResult } from "./baseline";
