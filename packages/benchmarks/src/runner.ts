/**
 * Benchmark runner: executes scripted cases through the v-a agent loop with
 * MockProvider, scores the final assistant text with the structural quality
 * gate, and aggregates run-level metrics (plan.md §Measurement).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Agent } from "@elysium/core";
import type { TurnResult } from "@elysium/core";
import {
  MockProvider,
  QualityGate,
  createBuiltinTools,
  createDefaultRubric,
  structuralJudge,
} from "@elysium/core";
import type {
  GateArtifact,
  PathPolicy,
  Tool,
  ToolResultMessage,
} from "@elysium/core";
import type { BenchmarkCase, CaseResult, RunSummary, TokenTotals } from "./types";

/** Minimum weighted quality score (0-10) for an attempt to count as a first pass. */
const FIRST_PASS_THRESHOLD = 8;
/** The runner retries a failed case once, at most. */
const MAX_RETRIES = 1;
/** Agent loop budget per attempt, per the benchmark contract. */
const MAX_TURNS = 4;

const SYSTEM_PROMPT =
  "You are a benchmark task executor. Use the available tools when needed, then answer concisely.";

/** Raised when a case cannot be executed to completion (script/agent/tool failure). */
export class BenchmarkCaseError extends Error {
  constructor(caseId: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`benchmark case '${caseId}' failed: ${message}`);
    this.name = "BenchmarkCaseError";
  }
}

export interface TaskRunnerOptions {
  /**
   * Custom case executor. When omitted, the default runner wires
   * MockProvider(case.script) + Agent (maxTurns 4) + structuralJudge.
   */
  taskRunner?: (benchmarkCase: BenchmarkCase) => Promise<CaseResult>;
  /**
   * Working directory handed to file/bash tools. When omitted, a fresh
   * temporary sandbox is created per run and removed afterwards.
   */
  sandboxRoot?: string;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function addTokens(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

function extractFinalAssistantText(result: TurnResult): string {
  const messages = [...result.messages].reverse();
  for (const message of messages) {
    if (message.role === "assistant") {
      return message.text;
    }
  }
  throw new Error("run produced no assistant message");
}

export class BenchmarkRunner {
  private readonly taskRunner: ((benchmarkCase: BenchmarkCase) => Promise<CaseResult>) | null;
  private readonly sandboxRoot: string | undefined;

  constructor(options: TaskRunnerOptions = {}) {
    this.taskRunner = options.taskRunner ?? null;
    this.sandboxRoot = options.sandboxRoot;
  }

  /**
   * Run every case and compute run-level aggregates.
   * firstPassRate = firstPass count / total, rounded to 2 decimals.
   */
  async runAll(cases: BenchmarkCase[]): Promise<RunSummary> {
    const startedAt = new Date().toISOString();
    const results: CaseResult[] = [];
    let sandbox: string | null = null;
    let created = false;
    if (this.sandboxRoot !== undefined) {
      sandbox = this.sandboxRoot;
    } else if (this.taskRunner === null) {
      sandbox = mkdtempSync(path.join(tmpdir(), "elysium-bench-"));
      created = true;
    }
    try {
      for (const benchmarkCase of cases) {
        if (this.taskRunner !== null) {
          results.push(await this.taskRunner(benchmarkCase));
        } else {
          results.push(await this.runCase(benchmarkCase, sandbox as string));
        }
      }
    } finally {
      if (created && sandbox !== null) {
        rmSync(sandbox, { recursive: true, force: true });
      }
    }
    const completedAt = new Date().toISOString();
    const total = results.length;
    const firstPassCount = results.reduce((acc, r) => acc + (r.firstPass ? 1 : 0), 0);
    const totalTokens = results.reduce((acc, r) => acc + r.tokens.inputTokens + r.tokens.outputTokens, 0);
    const totalLatency = results.reduce((acc, r) => acc + r.latencyMs, 0);
    const totalQuality = results.reduce((acc, r) => acc + r.qualityScore, 0);
    return {
      startedAt,
      completedAt,
      cases: results,
      firstPassRate: total === 0 ? 0 : round2(firstPassCount / total),
      avgTokens: total === 0 ? 0 : round2(totalTokens / total),
      avgLatencyMs: total === 0 ? 0 : round2(totalLatency / total),
      avgQuality: total === 0 ? 0 : round2(totalQuality / total),
    };
  }

  /**
   * Default case executor: attempt 1 decides firstPass; a failing case is
   * retried once (MAX_RETRIES). Tokens and latency accumulate across attempts;
   * qualityScore/attempts report the final attempt.
   */
  private async runCase(benchmarkCase: BenchmarkCase, sandbox: string): Promise<CaseResult> {
    let first: CaseResult;
    try {
      first = await this.executeAttempt(benchmarkCase, sandbox);
    } catch (cause: unknown) {
      throw new BenchmarkCaseError(benchmarkCase.id, cause);
    }
    if (first.qualityScore >= FIRST_PASS_THRESHOLD) {
      return { ...first, firstPass: true, attempts: 1 };
    }
    let second: CaseResult;
    try {
      second = await this.executeAttempt(benchmarkCase, sandbox);
    } catch (cause: unknown) {
      throw new BenchmarkCaseError(benchmarkCase.id, cause);
    }
    return {
      caseId: benchmarkCase.id,
      firstPass: false,
      tokens: addTokens(first.tokens, second.tokens),
      latencyMs: first.latencyMs + second.latencyMs,
      qualityScore: second.qualityScore,
      attempts: MAX_RETRIES + 1,
    };
  }

  private async executeAttempt(benchmarkCase: BenchmarkCase, sandbox: string): Promise<CaseResult> {
    const started = Date.now();
    const provider = new MockProvider(benchmarkCase.script);
    const policy: PathPolicy = { allowedRoots: [sandbox] };
    const tools: Tool[] = createBuiltinTools(policy);
    const toolMap = new Map<string, Tool>();
    for (const tool of tools) {
      toolMap.set(tool.name, tool);
    }
    const agent = new Agent({
      systemPrompt: SYSTEM_PROMPT,
      provider,
      tools,
      maxTurns: MAX_TURNS,
      executeTool: async (call, ctx): Promise<ToolResultMessage> => {
        const tool = toolMap.get(call.name);
        if (tool === undefined) {
          return {
            role: "tool_result",
            toolCallId: call.id,
            toolName: call.name,
            content: `unknown tool: ${call.name}`,
            isError: true,
          };
        }
        try {
          const result = await tool.execute(call.arguments, {
            cwd: sandbox,
            signal: ctx.signal,
            emit: () => {},
          });
          return {
            role: "tool_result",
            toolCallId: call.id,
            toolName: call.name,
            content: result.content,
            isError: result.isError,
            ...(result.details !== undefined ? { details: result.details } : {}),
          };
        } catch (cause: unknown) {
          const message = cause instanceof Error ? cause.message : String(cause);
          return {
            role: "tool_result",
            toolCallId: call.id,
            toolName: call.name,
            content: message,
            isError: true,
          };
        }
      },
    });
    const turnResult = await agent.run(benchmarkCase.description);
    const finalText = extractFinalAssistantText(turnResult);
    const gate = new QualityGate({ judge: structuralJudge });
    const artifact: GateArtifact = {
      taskId: benchmarkCase.id,
      kind: "text",
      content: finalText,
      criteria: benchmarkCase.criteria,
    };
    const score = await gate.evaluate(artifact, createDefaultRubric());
    return {
      caseId: benchmarkCase.id,
      firstPass: false,
      tokens: {
        inputTokens: turnResult.usage.inputTokens,
        outputTokens: turnResult.usage.outputTokens,
      },
      latencyMs: Date.now() - started,
      qualityScore: score.weighted,
      attempts: 1,
    };
  }
}
