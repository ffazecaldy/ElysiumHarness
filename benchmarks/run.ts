/**
 * Benchmark CLI entry: runs the standard scenarios, writes the baseline
 * markdown (docs/baseline.md), and prints the summary + comparison against
 * any existing baseline.
 *
 * Run: pnpm exec tsx benchmarks/run.ts
 */
import fs from "node:fs";
import path from "node:path";
import {
  BenchmarkRunner,
  compare,
  createStandardScenarios,
  readBaseline,
  writeBaseline,
} from "../packages/benchmarks/src/index";

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const baselinePath = path.join(repoRoot, "docs", "baseline.md");
  const previous = readBaseline(baselinePath);

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const runner = new BenchmarkRunner();
  const summary = await runner.runAll(createStandardScenarios());
  const wallMs = Date.now() - t0;

  console.log("=== elysium benchmark run ===");
  console.log(`started:  ${startedAt}`);
  console.log(`wall:     ${wallMs} ms`);
  for (const c of summary.cases) {
    console.log(
      `[${c.caseId}] firstPass=${c.firstPass} attempts=${c.attempts} ` +
        `tokens=${c.tokens.inputTokens}in/${c.tokens.outputTokens}out ` +
        `latency=${c.latencyMs}ms quality=${c.qualityScore}`,
    );
  }
  console.log(`firstPassRate: ${summary.firstPassRate}`);
  console.log(`avgTokens:     ${summary.avgTokens}`);
  console.log(`avgLatencyMs:  ${summary.avgLatencyMs}`);
  console.log(`avgQuality:    ${summary.avgQuality}`);

  writeBaseline(baselinePath, summary);
  console.log(`baseline written: ${baselinePath}`);

  if (previous) {
    const cmp = compare(summary, previous);
    console.log("--- comparison vs previous baseline ---");
    console.log(JSON.stringify(cmp, null, 2));
  } else {
    console.log("(no previous baseline — this run establishes it)");
  }
  void fs;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
