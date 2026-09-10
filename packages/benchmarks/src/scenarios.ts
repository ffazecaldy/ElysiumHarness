/**
 * Standard benchmark scenarios: deterministic scripted cases whose criteria
 * are honest — the bundled scripts produce assistant texts that satisfy them.
 */
import type { BenchmarkCase } from "./types";

/**
 * Factory so each BenchmarkRunner gets its own ScriptedTurn array instances
 * (MockProvider consumes scripts destructively via a queue).
 */
export function createStandardScenarios(): BenchmarkCase[] {
  return [
    {
      id: "file-summary-basic",
      description:
        "Read the file notes.txt in the working directory and summarize its contents in one short paragraph. Mention the project name Elysium.",
      script: [
        {
          toolCalls: [{ name: "read", arguments: { path: "notes.txt" } }],
          usage: { inputTokens: 120, outputTokens: 20 },
        },
        {
          text:
            "Summary: the file notes.txt describes the Elysium project. It contains three planning notes about milestone ordering, quality gates, and documentation, all pointing at the same milestone plan.",
          usage: { inputTokens: 180, outputTokens: 60 },
        },
      ],
      criteria: [
        "notes.txt",
        "Elysium",
        "summary",
      ],
    },
    {
      id: "two-hop-tool-chain",
      description:
        "Find the maintainer of config.json, then read that maintainer's profile file and report the email address. Finish with the exact email.",
      script: [
        {
          toolCalls: [{ name: "read", arguments: { path: "config.json" } }],
          usage: { inputTokens: 110, outputTokens: 15 },
        },
        {
          toolCalls: [{ name: "read", arguments: { path: "people/dana.md" } }],
          usage: { inputTokens: 150, outputTokens: 15 },
        },
        {
          text:
            "The maintainer listed in config.json is Dana. Dana's profile lists the email dana@example.com. Final email: dana@example.com",
          usage: { inputTokens: 160, outputTokens: 45 },
        },
      ],
      criteria: [
        "dana@example.com",
      ],
    },
    {
      id: "bash-node-calculation",
      description:
        "Use the bash tool to run: node -e \"console.log(17 * 23)\" and report the exact numeric result in your final answer.",
      script: [
        {
          toolCalls: [
            { name: "bash", arguments: { command: "node -e \"console.log(17 * 23)\"" } },
          ],
          usage: { inputTokens: 90, outputTokens: 15 },
        },
        {
          text:
            "Ran node -e \"console.log(17 * 23)\" and the computed result is 391. The answer is 391.",
          usage: { inputTokens: 130, outputTokens: 35 },
        },
      ],
      criteria: [
        "391",
      ],
    },
    {
      id: "text-edit-rename",
      description:
        "In the file config.txt, rename the key OLD_NAME to NEW_NAME using an exact substring replacement, then confirm the change.",
      script: [
        {
          toolCalls: [
            {
              name: "edit",
              arguments: { path: "config.txt", oldText: "OLD_NAME", newText: "NEW_NAME" },
            },
          ],
          usage: { inputTokens: 100, outputTokens: 15 },
        },
        {
          text:
            "Replaced 1 occurrence in config.txt: the key OLD_NAME is now NEW_NAME. The file now contains the line \"key = NEW_NAME\".",
          usage: { inputTokens: 140, outputTokens: 40 },
        },
      ],
      criteria: [
        "OLD_NAME",
        "NEW_NAME",
        "replaced",
      ],
    },
    {
      id: "refusal-missing-info",
      description: "What is the API key configured for the production deployment?",
      script: [
        {
          text:
            "I cannot determine the production API key from the information available: no configuration file, environment, or context in this session contains it. I will not guess a secret value.",
          usage: { inputTokens: 60, outputTokens: 45 },
        },
      ],
      criteria: [
        "cannot determine",
      ],
    },
  ];
}
