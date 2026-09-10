/**
 * Hierarchical Orchestration engine — Variant A: plan-graph executor.
 *
 * Executes a flat {@link OrchestrationPlan} (exactly one level of subtasks,
 * depth ≤ 2 by construction — a SubagentResult cannot carry a plan, so spawned
 * agents have no API to spawn further) with bounded concurrency. Each subtask
 * runs the optional critic against a FRESH context (only the task and its own
 * result — never sibling results), and failing critic gaps are appended to the
 * task context for a bounded number of repair rounds. Spawn rejections are
 * captured as failed results and never crash the run. Aborting the configured
 * signal marks tasks that have not started yet as failed with summary
 * "aborted"; already-running attempts settle naturally.
 */
import { randomBytes } from "node:crypto";
import type { HarnessEvent } from "../../../types/events";
import type {
  CriticVerdict,
  OrchestrationPlan,
  OrchestrationReport,
  SpawnFn,
  SubagentResult,
  SubagentTask,
  SubtaskReport,
} from "../../../types/orchestration";

/** Callback evaluating a single subtask attempt; receives a fresh context only. */
type CriticFn = (task: SubagentTask, result: SubagentResult) => Promise<CriticVerdict>;

/** Options for the {@link Orchestrator}. */
export interface OrchestratorOptions {
  /** Seam used to execute a single subtask (leaf agents only — depth ≤ 2 by construction). */
  spawn: SpawnFn;
  /**
   * Optional critic run after every spawn attempt. It receives ONLY the task and
   * that attempt's result — never the results of sibling subtasks.
   */
  critic?: CriticFn;
  /** Repair rounds (re-spawns) after failing critic gaps. Default 1. */
  repairRounds?: number;
  /** Maximum number of subtasks executed concurrently. Default 4. */
  maxConcurrency?: number;
  /** When aborted, tasks that have not started yet fail with summary "aborted". */
  signal?: AbortSignal;
  /** Telemetry sink receiving typed harness events for this run. */
  onEvent?: (event: HarnessEvent) => void;
}

const DEFAULT_REPAIR_ROUNDS = 1;
const DEFAULT_MAX_CONCURRENCY = 4;
/** The only depth an OrchestrationPlan may declare (type-level MaxDepth = 2). */
const MAX_DEPTH = 2;
const RUN_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Generates a ULID-style run id: 10 chars of millisecond timestamp + 16 random chars. */
function generateRunId(): string {
  let time = Date.now();
  let timestampPart = "";
  for (let i = 0; i < 10; i += 1) {
    timestampPart = RUN_ID_ALPHABET.charAt(time % 32) + timestampPart;
    time = Math.floor(time / 32);
  }
  let randomPart = "";
  for (const byte of randomBytes(16)) {
    randomPart += RUN_ID_ALPHABET.charAt(byte % 32);
  }
  return timestampPart + randomPart;
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortedResult(taskId: string): SubagentResult {
  return { taskId, status: "fail", summary: "aborted", artifacts: [] };
}

/**
 * Returns a respawn copy of the task with the critic's gaps appended to its
 * context. The planned task object is never mutated.
 */
function taskWithCriticGaps(task: SubagentTask, gaps: string[], round: number): SubagentTask {
  const bulletLines = gaps.length > 0 ? gaps : ["(critic reported no specific gaps)"];
  const bullets = bulletLines.map((gap) => `- ${gap}`).join("\n");
  const gapBlock = `Critic feedback, repair round ${round} — address these gaps:\n${bullets}`;
  return {
    ...task,
    context: task.context === undefined ? gapBlock : `${task.context}\n\n${gapBlock}`,
  };
}

/**
 * Plan-graph executor over a flat {@link OrchestrationPlan}.
 * Depth is capped at 2 by construction: see `docs/architecture.md` §2 and §4.
 */
export class Orchestrator {
  private readonly spawn: SpawnFn;
  private readonly critic?: CriticFn;
  private readonly repairRounds: number;
  private readonly maxConcurrency: number;
  private readonly signal?: AbortSignal;
  private readonly onEvent?: (event: HarnessEvent) => void;

  constructor(options: OrchestratorOptions) {
    this.spawn = options.spawn;
    this.critic = options.critic;
    this.repairRounds = Math.max(0, options.repairRounds ?? DEFAULT_REPAIR_ROUNDS);
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.signal = options.signal;
    this.onEvent = options.onEvent;
  }

  /** Validates and executes the plan, returning a per-subtask report. */
  async execute(plan: OrchestrationPlan): Promise<OrchestrationReport> {
    this.validatePlan(plan);
    const runId = generateRunId();
    const startedAtMs = Date.now();
    const reports: SubtaskReport[] = new Array<SubtaskReport>(plan.subtasks.length);
    let cursor = 0;
    const workerCount = Math.min(this.maxConcurrency, plan.subtasks.length);

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const task = plan.subtasks[index];
        if (task === undefined) {
          return;
        }
        reports[index] = await this.runSubtask(runId, task);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return {
      goal: plan.goal,
      completedAt: nowIso(),
      subtasks: reports,
      allPassed: reports.every((report) => report.result.status === "pass"),
      totalDurationMs: Date.now() - startedAtMs,
    };
  }

  /** maxDepth must be exactly 2 (rejected at runtime for non-TS callers too). */
  private validatePlan(plan: OrchestrationPlan): void {
    if (plan.maxDepth !== MAX_DEPTH) {
      throw new Error(
        `Invalid orchestration plan: maxDepth must be ${MAX_DEPTH}, received ${String(plan.maxDepth)}.`,
      );
    }
    if (plan.subtasks.length === 0) {
      throw new Error("Invalid orchestration plan: subtasks must not be empty.");
    }
    const seenIds = new Set<string>();
    for (const task of plan.subtasks) {
      if (seenIds.has(task.id)) {
        throw new Error(`Invalid orchestration plan: duplicate subtask id "${task.id}".`);
      }
      seenIds.add(task.id);
    }
  }

  /**
   * Runs one subtask to completion: initial spawn, optional fresh-context critic,
   * and bounded repair rounds that re-spawn the same task with the critic gaps
   * appended to its context. Emits task_started, task_ended and task-scope
   * latency events for this run.
   */
  private async runSubtask(runId: string, task: SubagentTask): Promise<SubtaskReport> {
    if (this.signal?.aborted) {
      // Never started: reported as aborted, no lifecycle events are emitted.
      return { task, result: abortedResult(task.id) };
    }
    const startedAtMs = Date.now();
    this.emit({
      type: "task_started",
      timestamp: nowIso(),
      runId,
      taskId: task.id,
      data: { goal: task.goal },
    });

    let attemptTask: SubagentTask = task;
    let result = await this.spawnSafely(runId, attemptTask);
    let attempts = 1;
    let verdict: CriticVerdict | undefined;
    if (this.critic !== undefined) {
      verdict = await this.runCritic(this.critic, runId, attemptTask, result);
      for (let round = 1; round <= this.repairRounds && !verdict.passed; round += 1) {
        if (this.signal?.aborted) {
          break;
        }
        attemptTask = taskWithCriticGaps(attemptTask, verdict.gaps, round);
        result = await this.spawnSafely(runId, attemptTask);
        attempts += 1;
        verdict = await this.runCritic(this.critic, runId, attemptTask, result);
      }
    }

    const durationMs = Date.now() - startedAtMs;
    this.emit({
      type: "task_ended",
      timestamp: nowIso(),
      runId,
      taskId: task.id,
      data: { status: result.status, durationMs, attempts },
    });
    this.emit({
      type: "latency",
      timestamp: nowIso(),
      runId,
      taskId: task.id,
      data: { scope: "task", durationMs },
    });
    // The report keeps the original planned task; repair used detached copies.
    return { task, result, critic: verdict };
  }

  /** Spawn rejections are captured as failed results; they never crash the run. */
  private async spawnSafely(runId: string, task: SubagentTask): Promise<SubagentResult> {
    try {
      return await this.spawn(task);
    } catch (error) {
      const message = errorMessage(error);
      this.emit({
        type: "error",
        timestamp: nowIso(),
        runId,
        taskId: task.id,
        data: { message: `spawn failed: ${message}`, scope: "task" },
      });
      return {
        taskId: task.id,
        status: "fail",
        summary: `spawn failed: ${message}`,
        artifacts: [],
      };
    }
  }

  /**
   * Runs the critic with a FRESH context: only the task and this attempt's
   * result are passed — sibling results are structurally unreachable. A critic
   * that throws is captured as a failed verdict (with the error as a gap) so it
   * feeds the bounded repair loop instead of crashing the run.
   */
  private async runCritic(
    critic: CriticFn,
    runId: string,
    task: SubagentTask,
    result: SubagentResult,
  ): Promise<CriticVerdict> {
    try {
      return await critic(task, result);
    } catch (error) {
      const message = errorMessage(error);
      this.emit({
        type: "error",
        timestamp: nowIso(),
        runId,
        taskId: task.id,
        data: { message: `critic failed: ${message}`, scope: "task" },
      });
      return { passed: false, gaps: [`critic failed: ${message}`] };
    }
  }

  private emit(event: HarnessEvent): void {
    this.onEvent?.(event);
  }
}
