/**
 * Integration tests: agent end-to-end through the executeTool seam,
 * orchestrator pipeline with fresh-context critic + repair, quality gate
 * scoring over subtask outputs, and pre-aborted abort semantics.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Agent,
  isToolResultMessage,
  MockProvider,
  Orchestrator,
  QualityGate,
  ToolRegistry,
  createDefaultRubric,
  createReadTool,
  structuralJudge,
  type AgentOptions,
  type CriticVerdict,
  type GateArtifact,
  type HarnessEvent,
  type LlmRequest,
  type OrchestrationPlan,
  type PathPolicy,
  type ScriptedTurn,
  type SpawnFn,
  type SubagentResult,
  type SubagentTask,
  type Tool,
  type ToolCallPart,
  type ToolResult,
  type ToolResultMessage,
} from "@elysium/core";

const SEED_MARKER = "ELYSIUM-SEED-9f27c";
const SEED_CONTENT = `${SEED_MARKER}: pineapples orbit mars on tuesdays.`;
const SEED_REL = "seed.txt";
const AGENT_SYSTEM_PROMPT =
  "You operate a sandbox. Use the read tool to inspect files before summarizing.";
const LAZY_TEXT = "attempt-1: nothing to report";
const GAMMA_ID = "task-gamma";
/** Marker the canonical orchestrator appends to a task context on repair. */
const REPAIR_CONTEXT_MARKER = "Critic feedback, repair round";

interface Sandbox {
  root: string;
  seedPath: string;
  registry: ToolRegistry;
  readCalls: Array<Record<string, unknown>>;
}

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeSandbox(): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "elysium-int-"));
  tmpRoots.push(root);
  const seedPath = path.join(root, SEED_REL);
  fs.writeFileSync(seedPath, SEED_CONTENT, "utf-8");
  const policy: PathPolicy = { allowedRoots: [root] };
  const readCalls: Array<Record<string, unknown>> = [];
  const base = createReadTool(policy);
  const readTool: Tool = {
    ...base,
    execute: async (args, ctx) => {
      readCalls.push(args);
      return base.execute(args, ctx);
    },
  };
  const registry = new ToolRegistry();
  registry.register(readTool);
  return { root, seedPath, registry, readCalls };
}

/** The agent executeTool seam: ToolCallPart -> registry tool execute -> ToolResultMessage. */
function makeExecuteTool(
  sandbox: Sandbox,
  events: HarnessEvent[],
): NonNullable<AgentOptions["executeTool"]> {
  return async (call: ToolCallPart, ctx: { signal: AbortSignal }): Promise<ToolResultMessage> => {
    const tool = sandbox.registry.get(call.name);
    if (!tool) {
      const missing: ToolResultMessage = {
        role: "tool_result",
        toolCallId: call.id,
        toolName: call.name,
        content: `unknown tool '${call.name}'`,
        isError: true,
      };
      return missing;
    }
    const result: ToolResult = await tool.execute(call.arguments, {
      cwd: sandbox.root,
      signal: ctx.signal,
      emit: (e: HarnessEvent) => events.push(e),
    });
    const message: ToolResultMessage = {
      role: "tool_result",
      toolCallId: call.id,
      toolName: call.name,
      content: result.content,
      isError: result.isError,
      ...(result.details !== undefined ? { details: result.details } : {}),
    };
    return message;
  };
}

/**
 * Deterministic scripted model: ask for the read tool first, then quote the
 * ToolResultMessage that came back through the seam. The "gamma" subtask is
 * lazy on its first attempt (no tool call) so the critic fails it, and
 * cooperative once the orchestrator appended repair feedback to its context.
 */
function scriptFor(task: SubagentTask, req: LlmRequest): ScriptedTurn {
  const repairing = (task.context ?? "").includes("Critic feedback");
  if (task.id === GAMMA_ID && !repairing) {
    return { text: LAZY_TEXT };
  }
  const toolResult = [...req.messages].reverse().find(isToolResultMessage);
  if (toolResult) {
    return { text: `summary: ${toolResult.content}` };
  }
  return {
    text: "Inspecting the sandbox.",
    toolCalls: [{ id: `${task.id}-call-1`, name: "read", arguments: { path: SEED_REL } }],
  };
}

function makeAgentSpawn(sandbox: Sandbox, events: HarnessEvent[]): SpawnFn {
  return async (task: SubagentTask): Promise<SubagentResult> => {
    const agent = new Agent({
      systemPrompt: AGENT_SYSTEM_PROMPT,
      provider: new MockProvider((req) => scriptFor(task, req)),
      tools: sandbox.registry.list(),
      maxTurns: 4,
      executeTool: makeExecuteTool(sandbox, events),
    });
    const run = await agent.run(task.goal);
    const last = run.messages[run.messages.length - 1];
    if (last === undefined || last.role !== "assistant") {
      throw new Error(`task ${task.id}: agent did not end with an assistant message`);
    }
    return { taskId: task.id, status: "pass", summary: last.text, artifacts: [sandbox.seedPath] };
  };
}

/** Fresh-context critic: verdict depends only on the task and this attempt's result. */
async function seedCritic(_task: SubagentTask, result: SubagentResult): Promise<CriticVerdict> {
  if (result.summary.includes(SEED_MARKER)) {
    return { passed: true, gaps: [] };
  }
  return { passed: false, gaps: [`summary must quote the seed marker '${SEED_MARKER}'`] };
}

describe("agent end-to-end through the executeTool seam", () => {
  it("maps ToolCallPart -> registry tool execute -> ToolResultMessage and answers with file content", async () => {
    const sandbox = makeSandbox();
    const events: HarnessEvent[] = [];
    const agent = new Agent({
      systemPrompt: AGENT_SYSTEM_PROMPT,
      provider: new MockProvider((req) =>
        scriptFor({ id: "solo", goal: "Read seed.txt." }, req),
      ),
      tools: sandbox.registry.list(),
      maxTurns: 4,
      executeTool: makeExecuteTool(sandbox, events),
    });

    const run = await agent.run("Read seed.txt and tell me what it contains.");

    expect(run.stopReason).toBe("end_turn");
    expect(run.turns).toBe(2);
    expect(run.usage.outputTokens).toBeGreaterThan(0);

    // The seam really executed the registry tool with the scripted arguments.
    expect(sandbox.readCalls).toEqual([{ path: SEED_REL }]);

    // A ToolResultMessage was appended carrying the scripted call id and file content.
    const toolResults = run.messages.filter(isToolResultMessage);
    expect(toolResults.length).toBe(1);
    const toolResult = toolResults[0];
    expect(toolResult).toBeDefined();
    if (toolResult) {
      expect(toolResult.toolCallId).toBe("solo-call-1");
      expect(toolResult.toolName).toBe("read");
      expect(toolResult.isError).toBe(false);
      expect(toolResult.content).toContain(SEED_MARKER);
    }

    // Final assistant answer references the seeded file content.
    const final = run.messages[run.messages.length - 1];
    expect(final?.role).toBe("assistant");
    if (final?.role === "assistant") {
      expect(final.text).toContain(SEED_MARKER);
      expect(final.stopReason).toBe("end_turn");
    }

    // The read tool emitted its telemetry through the same event pipe.
    expect(events.some((e) => e.type === "tool_called" && e.data["tool"] === "read")).toBe(true);
  });
});

describe("orchestrator: 3 subtasks, concurrency 2, critic repair, latency events", () => {
  it("repairs the failing subtask once and passes every subtask in plan order", async () => {
    const sandbox = makeSandbox();
    const events: HarnessEvent[] = [];
    const agentSpawn = makeAgentSpawn(sandbox, events);
    const spawnCounts = new Map<string, number>();
    const spawn: SpawnFn = async (task: SubagentTask): Promise<SubagentResult> => {
      spawnCounts.set(task.id, (spawnCounts.get(task.id) ?? 0) + 1);
      return agentSpawn(task);
    };
    const orchestrator = new Orchestrator({
      spawn,
      critic: seedCritic,
      repairRounds: 1,
      maxConcurrency: 2,
      onEvent: (e: HarnessEvent) => events.push(e),
    });

    const subtasks: SubagentTask[] = [
      {
        id: "task-alpha",
        goal: "Read seed.txt and summarize it.",
        context: "Sandbox: use the read tool on 'seed.txt'.",
      },
      {
        id: "task-beta",
        goal: "Read seed.txt and quote it.",
        context: "Sandbox: use the read tool on 'seed.txt'.",
      },
      {
        id: GAMMA_ID,
        goal: "Report sandbox state.",
        context: "Sandbox: use the read tool on 'seed.txt'.",
      },
    ];
    const plan: OrchestrationPlan = {
      goal: "Verify the sandbox seed",
      maxDepth: 2,
      subtasks,
      critic: { enabled: true, repairRounds: 1 },
    };

    const report = await orchestrator.execute(plan);

    // Overall verdict and plan ordering.
    expect(report.allPassed).toBe(true);
    expect(report.goal).toBe(plan.goal);
    expect(report.subtasks.map((r) => r.task.id)).toEqual(["task-alpha", "task-beta", GAMMA_ID]);

    // The lazy subtask failed the critic, was respawned once, then passed.
    expect(spawnCounts.get(GAMMA_ID)).toBe(2);
    expect(spawnCounts.get("task-alpha")).toBe(1);
    expect(spawnCounts.get("task-beta")).toBe(1);
    for (const r of report.subtasks) {
      expect(r.result.status).toBe("pass");
      expect(r.result.summary).toContain(SEED_MARKER);
      expect(r.critic?.passed).toBe(true);
    }
    const gamma = report.subtasks.find((r) => r.task.id === GAMMA_ID);
    expect(gamma).toBeDefined();
    if (gamma) {
      expect(gamma.result.summary).not.toContain(LAZY_TEXT);
    }
    // Tool flow: alpha reads once, beta reads once, gamma-lazy reads zero,
    // gamma-repair reads once => 3 reads through the agent seam.
    expect(sandbox.readCalls.length).toBe(3);

    // Latency events arrived for every subtask via onEvent.
    const latency = events.filter((e) => e.type === "latency");
    const latencyTaskIds = new Set(latency.map((e) => e.taskId));
    for (const id of ["task-alpha", "task-beta", GAMMA_ID]) {
      expect(latencyTaskIds.has(id)).toBe(true);
    }
    expect(latency.every((e) => e.data["scope"] === "task")).toBe(true);

    // One task_started per subtask; the gamma task_ended reports 2 attempts.
    const started = events.filter((e) => e.type === "task_started");
    expect(new Set(started.map((e) => e.taskId)).size).toBe(3);
    const gammaEnded = events.find(
      (e) => e.type === "task_ended" && e.taskId === GAMMA_ID,
    );
    expect(gammaEnded).toBeDefined();
    if (gammaEnded) {
      expect(gammaEnded.data["attempts"]).toBe(2);
      expect(gammaEnded.data["status"]).toBe("pass");
    }

    // Observed concurrency never exceeded maxConcurrency 2 and did reach 2.
    let active = 0;
    let maxActive = 0;
    for (const e of events) {
      if (e.type === "task_started") {
        active += 1;
        maxActive = Math.max(maxActive, active);
      } else if (e.type === "task_ended") {
        active -= 1;
      }
    }
    expect(maxActive).toBe(2);
  });
});

describe("quality gate over subtask outputs", () => {
  it("scores outputs with QualityGate + default rubric + structuralJudge and records scores", async () => {
    const sandbox = makeSandbox();
    const events: HarnessEvent[] = [];
    const orchestrator = new Orchestrator({
      spawn: makeAgentSpawn(sandbox, events),
      maxConcurrency: 2,
      onEvent: (e: HarnessEvent) => events.push(e),
    });
    const plan: OrchestrationPlan = {
      goal: "Produce seed summaries",
      maxDepth: 2,
      subtasks: [
        {
          id: "gate-1",
          goal: "Read seed.txt and summarize it.",
          context: "Sandbox: use the read tool on 'seed.txt'.",
        },
        {
          id: "gate-2",
          goal: "Read seed.txt and quote it.",
          context: "Sandbox: use the read tool on 'seed.txt'.",
        },
      ],
    };
    const report = await orchestrator.execute(plan);
    expect(report.allPassed).toBe(true);

    const rubric = createDefaultRubric();
    const gate = new QualityGate({ judge: structuralJudge });
    const recorded: Array<{ taskId: string; weighted: number }> = [];
    for (const r of report.subtasks) {
      const artifact: GateArtifact = {
        taskId: r.task.id,
        kind: "text",
        content: r.result.summary,
        criteria: [SEED_MARKER],
      };
      const score = await gate.evaluate(artifact, rubric);
      expect(score.passed).toBe(true);
      expect(score.dimensions.length).toBe(rubric.dimensions.length);
      expect(score.weighted).toBeGreaterThanOrEqual(rubric.threshold);
      expect(score.reasons).toEqual([]);
      for (const dim of score.dimensions) {
        expect(dim.score).toBeGreaterThanOrEqual(0);
        expect(dim.score).toBeLessThanOrEqual(10);
        expect(dim.reason.length).toBeGreaterThan(0);
      }
      r.result.score = score;
      recorded.push({ taskId: r.task.id, weighted: score.weighted });
    }
    expect(recorded.length).toBe(2);
    expect(report.subtasks.every((r) => r.result.score !== undefined)).toBe(true);

    // Negative control: an output missing the criterion fails with targeted reasons.
    const failing = await gate.evaluate(
      { kind: "text", content: "an unrelated summary", criteria: [SEED_MARKER] },
      rubric,
    );
    expect(failing.passed).toBe(false);
    expect(failing.reasons.length).toBeGreaterThan(0);

    // structuralJudge directly: full criteria coverage scores top marks.
    const direct = await structuralJudge(
      { kind: "text", content: `covers ${SEED_MARKER} fully`, criteria: [SEED_MARKER] },
      rubric,
    );
    expect(direct.passed).toBe(true);
    expect(direct.dimensions.every((d) => d.score === 10)).toBe(true);
  });
});

describe("orchestrator abort semantics", () => {
  it("marks every task failed as aborted and resolves when the signal is pre-aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawnCalls = 0;
    const events: HarnessEvent[] = [];
    const orchestrator = new Orchestrator({
      spawn: async (): Promise<SubagentResult> => {
        spawnCalls += 1;
        throw new Error("spawn must not run when pre-aborted");
      },
      onEvent: (e: HarnessEvent) => events.push(e),
      signal: controller.signal,
    });
    const plan: OrchestrationPlan = {
      goal: "Never runs",
      maxDepth: 2,
      subtasks: [
        { id: "abort-1", goal: "g1" },
        { id: "abort-2", goal: "g2" },
      ],
    };

    const report = await orchestrator.execute(plan);

    expect(report.allPassed).toBe(false);
    expect(report.subtasks.map((r) => r.task.id)).toEqual(["abort-1", "abort-2"]);
    for (const r of report.subtasks) {
      expect(r.result.status).toBe("fail");
      expect(r.result.summary).toBe("aborted");
    }
    expect(spawnCalls).toBe(0);
    // Never-started tasks report as aborted without lifecycle events.
    expect(events.length).toBe(0);
  });
});
