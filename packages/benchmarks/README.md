# @elysium/benchmarks

Benchmark + eval suite for Elysium Harness: runs scripted benchmark cases
through the core agent loop, scores outputs with the streaming quality gate,
and compares runs against a committed markdown baseline.

## Running benchmarks (programmatic usage)

```ts
import {
  BenchmarkRunner,
  compare,
  createStandardScenarios,
  readBaseline,
  writeBaseline,
} from "@elysium/benchmarks";

const runner = new BenchmarkRunner();
const summary = await runner.runAll(createStandardScenarios());

console.log(`first-pass rate: ${summary.firstPassRate}`);
console.log(`avg tokens: ${summary.avgTokens}`);
console.log(`avg latency: ${summary.avgLatencyMs} ms`);
console.log(`avg quality: ${summary.avgQuality}`);

const baselinePath = "docs/baseline.md";
writeBaseline(baselinePath, summary); // --update-baseline

const baseline = readBaseline(baselinePath);
if (baseline !== null) {
  const result = compare(summary, baseline);
  for (const regression of result.regressions) {
    console.error(`REGRESSION: ${regression}`);
  }
}
```

Supply your own case executor (e.g. to benchmark a live provider) via the
constructor option:

```ts
const runner = new BenchmarkRunner({
  taskRunner: async (benchmarkCase) => {
    // run the case however you like, then return a CaseResult
    return {
      caseId: benchmarkCase.id,
      firstPass: true,
      tokens: { inputTokens: 0, outputTokens: 0 },
      latencyMs: 0,
      qualityScore: 10,
      attempts: 1,
    };
  },
});
```

The default runner wires `MockProvider(case.script)` + `Agent` (`maxTurns: 4`)
+ the structural quality judge over the final assistant text; a failed case is
retried once at most, and a fresh temporary sandbox directory is used for file
and bash tools on every run.

## Metric definitions (from plan.md §Measurement)

- **first-pass rate** = tasks accepted at quality gate on first attempt /
  total tasks (per benchmark run). In code: cases with `qualityScore >= 8` on
  attempt 1, divided by total cases; first-pass status is never granted by a
  retry.
- **token usage** = prompt + completion tokens per task/run (from provider
  usage or mock counter). Aggregated per case from `TurnResult.usage` across
  all turns and all attempts; `avgTokens` is the mean per case.
- **latency** = wall-clock per turn and per task (ms), recorded on the event
  bus. Here: wall-clock ms per case across all attempts; `avgLatencyMs` is the
  mean per case.
- **quality score** = weighted rubric (correctness .30, efficiency .30,
  maintainability .20, principle-adherence .20), 0–10. The default rubric
  threshold (8.0) is the first-pass bar.

All aggregates are rounded to 2 decimals.

## Standard scenarios

`createStandardScenarios()` returns five deterministic scripted cases:

| id | What it exercises |
| --- | --- |
| `file-summary-basic` | read tool + grounded summary of a file |
| `two-hop-tool-chain` | chained tool calls (config → profile → answer) |
| `bash-node-calculation` | calculation via `bash` + `node -e` |
| `text-edit-rename` | exact-substring `edit` with confirmation |
| `refusal-missing-info` | explicit "cannot determine" refusal when the requested information is not available |

## Baseline workflow

The suite follows a **write + compare** philosophy, mirroring a
`--update-baseline` flag:

1. `writeBaseline(path, summary)` writes a human-readable markdown report —
   metadata, per-case table, and the full `RunSummary` embedded as a fenced
   ` ```json ` block (the machine-readable source of truth).
2. `readBaseline(path)` parses that fence back into a `RunSummary` (returns
   `null` when the file does not exist, throws on malformed content).
3. `compare(current, baseline)` returns deltas (`current - baseline`) for
   first-pass rate, tokens, latency, and quality, plus a `regressions` list:
   a regression is any metric that moves in the wrong direction (first-pass
   rate or quality down, tokens or latency up) by more than 5% of the
   baseline value.

Typical flow: refresh the baseline only deliberately (`writeBaseline` to
re-record a known-good run), and on every other run compare against it and
treat `regressions.length > 0` as a failed check.
