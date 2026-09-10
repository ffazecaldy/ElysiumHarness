# Elysium Harness — Benchmark Baseline

- **Started at:** 2026-09-10T11:18:58.131Z
- **Completed at:** 2026-09-10T11:18:58.211Z
- **Cases:** 5

## Summary

| Metric | Value |
| --- | --- |
| First-pass rate | 1 |
| Avg tokens | 309 |
| Avg latency (ms) | 15.6 |
| Avg quality | 10 |

## Per-case results

| Case | First pass | Input tokens | Output tokens | Latency (ms) | Quality | Attempts |
| --- | --- | --- | --- | --- | --- | --- |
| file-summary-basic | yes | 300 | 80 | 3 | 10 | 1 |
| two-hop-tool-chain | yes | 420 | 75 | 1 | 10 | 1 |
| bash-node-calculation | yes | 220 | 50 | 73 | 10 | 1 |
| text-edit-rename | yes | 240 | 55 | 1 | 10 | 1 |
| refusal-missing-info | yes | 60 | 45 | 0 | 10 | 1 |

## Machine-readable snapshot

The fenced JSON block below is the canonical baseline record; `readBaseline()` parses it back.

```json
{
  "startedAt": "2026-09-10T11:18:58.131Z",
  "completedAt": "2026-09-10T11:18:58.211Z",
  "cases": [
    {
      "caseId": "file-summary-basic",
      "firstPass": true,
      "tokens": {
        "inputTokens": 300,
        "outputTokens": 80
      },
      "latencyMs": 3,
      "qualityScore": 10,
      "attempts": 1
    },
    {
      "caseId": "two-hop-tool-chain",
      "firstPass": true,
      "tokens": {
        "inputTokens": 420,
        "outputTokens": 75
      },
      "latencyMs": 1,
      "qualityScore": 10,
      "attempts": 1
    },
    {
      "caseId": "bash-node-calculation",
      "firstPass": true,
      "tokens": {
        "inputTokens": 220,
        "outputTokens": 50
      },
      "latencyMs": 73,
      "qualityScore": 10,
      "attempts": 1
    },
    {
      "caseId": "text-edit-rename",
      "firstPass": true,
      "tokens": {
        "inputTokens": 240,
        "outputTokens": 55
      },
      "latencyMs": 1,
      "qualityScore": 10,
      "attempts": 1
    },
    {
      "caseId": "refusal-missing-info",
      "firstPass": true,
      "tokens": {
        "inputTokens": 60,
        "outputTokens": 45
      },
      "latencyMs": 0,
      "qualityScore": 10,
      "attempts": 1
    }
  ],
  "firstPassRate": 1,
  "avgTokens": 309,
  "avgLatencyMs": 15.6,
  "avgQuality": 10
}
```
