/**
 * Hierarchical Orchestration — VARIANT C (critic-first, retry-budgeted).
 * Global repair budget = repairRounds * subtasks.length; each
 * critic-triggered respawn consumes 1. When the budget is exhausted,
 * further critic failures are recorded as gaps without respawn.
 */
import { randomUUID } from "node:crypto";
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

export interface OrchestratorOptions {
  spawn: SpawnFn;
  critic?: (task: SubagentTask, result: SubagentResult) => Promise<CriticVerdict>;
  repairRounds?: number;
  maxConcurrency?: number;
  signal?: AbortSignal;
  onEvent?: (e: HarnessEvent) => void;
}

interface PendingWork {
  task: SubagentTask;
  repairCount: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class Orchestrator {
  private readonly spawn: SpawnFn;
  private readonly critic?: (task: SubagentTask, result: SubagentResult) => Promise<CriticVerdict>;
  private readonly repairRounds: number;
  private readonly maxConcurrency: number;
  private readonly signal: AbortSignal | undefined;
  private readonly onEvent?: (e: HarnessEvent) => void;

  constructor(options: OrchestratorOptions) {
    this.spawn = options.spawn;
    this.critic = options.critic;
    this.repairRounds = options.repairRounds ?? 1;
    this.maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
    this.signal = options.signal;
    this.onEvent = options.onEvent;
  }

  async execute(plan: OrchestrationPlan): Promise<OrchestrationReport> {
    if (plan.maxDepth !== 2) {
      throw new Error(`maxDepth must be 2, got ${String(plan.maxDepth)}`);
    }
    if (!Array.isArray(plan.subtasks) || plan.subtasks.length === 0) {
      throw new Error("plan must contain at least one subtask");
    }
    const ids = new Set<string>();
    for (const t of plan.subtasks) {
      if (ids.has(t.id)) {
        throw new Error(`duplicate task id: ${t.id}`);
      }
      ids.add(t.id);
    }

    const runId = randomUUID();
    const startedAt = Date.now();
    const abortedSet = new Set<string>();
    const reports = new Map<string, SubtaskReport>();
    const queue: PendingWork[] = plan.subtasks.map((t) => ({ task: t, repairCount: 0 }));
    let retryBudget = this.repairRounds * plan.subtasks.length;
    let cursor = 0;

    const emit = (event: HarnessEvent): void => {
      this.onEvent?.(event);
    };

    const runOne = async (work: PendingWork): Promise<void> => {
      if (this.signal?.aborted) {
        abortedSet.add(work.task.id);
        return;
      }
      emit({
        type: "task_started",
        timestamp: nowIso(),
        runId,
        taskId: work.task.id,
        data: { repair: work.repairCount },
      });
      const t0 = Date.now();
      let result: SubagentResult;
      try {
        result = await this.spawn(work.task);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        result = {
          taskId: work.task.id,
          status: "fail",
          summary: `spawn failed: ${message}`,
          artifacts: [],
        };
      }
      const durationMs = Date.now() - t0;
      let verdict: CriticVerdict | undefined;
      if (this.critic && result.status === "pass") {
        try {
          verdict = await this.critic(work.task, result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          verdict = { passed: false, gaps: [`critic failed: ${message}`] };
        }
      }
      const needsRepair =
        verdict !== undefined && !verdict.passed && work.repairCount < this.repairRounds;
      if (needsRepair && retryBudget > 0) {
        retryBudget -= 1;
        const repaired: PendingWork = {
          task: {
            ...work.task,
            context:
              `${work.task.context ?? ""}\nREPAIR GAPS:\n${verdict?.gaps.join("\n") ?? ""}`.trim(),
          },
          repairCount: work.repairCount + 1,
        };
        emit({
          type: "task_ended",
          timestamp: nowIso(),
          runId,
          taskId: work.task.id,
          data: { status: "repair_scheduled", durationMs },
        });
        emit({
          type: "latency",
          timestamp: nowIso(),
          runId,
          taskId: work.task.id,
          data: { scope: "task", durationMs },
        });
        queue.push(repaired);
        return;
      }
      if (needsRepair && verdict) {
        // Budget exhausted: record the gaps, keep the best-known result.
        result = {
          ...result,
          summary: `${result.summary} [unrepaired gaps: ${verdict.gaps.join("; ")}]`,
        };
      }
      if (work.repairCount > 0) {
        result = { ...result, summary: `[repair ${work.repairCount}] ${result.summary}` };
      }
      reports.set(work.task.id, {
        task: work.task,
        result,
        ...(verdict ? { critic: verdict } : {}),
      });
      emit({
        type: "task_ended",
        timestamp: nowIso(),
        runId,
        taskId: work.task.id,
        data: { status: result.status, durationMs },
      });
      emit({
        type: "latency",
        timestamp: nowIso(),
        runId,
        taskId: work.task.id,
        data: { scope: "task", durationMs },
      });
    };

    const workers: Promise<void>[] = [];
    const pump = async (): Promise<void> => {
      while (cursor < queue.length || workersLeft > 0) {
        if (this.signal?.aborted) {
          for (const w of queue.slice(cursor)) abortedSet.add(w.task.id);
          cursor = queue.length;
          return;
        }
        while (cursor < queue.length && active < this.maxConcurrency) {
          const work = queue[cursor];
          if (!work) return;
          cursor += 1;
          active += 1;
          workersLeft += 1;
          void runOne(work).finally(() => {
            active -= 1;
            workersLeft -= 1;
          });
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
    };
    let active = 0;
    let workersLeft = 0;
    await pump();
    await Promise.all(workers);

    const ordered = plan.subtasks.map((t) => {
      const found = reports.get(t.id);
      if (found) return found;
      return {
        task: t,
        result: {
          taskId: t.id,
          status: "fail" as const,
          summary: "aborted",
          artifacts: [],
        },
      };
    });
    // Keep the latest repair report per task (Map overwrite already ensures that).
    return {
      goal: plan.goal,
      completedAt: nowIso(),
      subtasks: ordered,
      allPassed: ordered.every((r) => r.result.status === "pass" && (r.critic?.passed ?? true)),
      totalDurationMs: Date.now() - startedAt,
    };
  }
}
