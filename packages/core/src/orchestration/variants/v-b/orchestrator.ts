/**
 * Hierarchical Orchestration — VARIANT B (streaming pipeline).
 * No barrier: as soon as a subtask finishes, its critic + repair round
 * starts immediately while concurrency slots admit the next subtask.
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
    if (plan.subtasks.length === 0) {
      throw new Error("plan must contain at least one subtask");
    }
    const seen = new Set<string>();
    for (const t of plan.subtasks) {
      if (seen.has(t.id)) throw new Error(`duplicate task id: ${t.id}`);
      seen.add(t.id);
    }

    const runId = randomUUID();
    const startedAt = Date.now();
    const reports = new Map<string, SubtaskReport>();
    const repairCounts = new Map<string, number>();
    const pending = [...plan.subtasks];
    let inFlight = 0;
    let index = 0;

    const emit = (e: HarnessEvent): void => this.onEvent?.(e);

    const processResult = async (
      task: SubagentTask,
      result: SubagentResult,
      durationMs: number,
      repairCount: number,
    ): Promise<void> => {
      let verdict: CriticVerdict | undefined;
      if (this.critic && result.status === "pass") {
        try {
          verdict = await this.critic(task, result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          verdict = { passed: false, gaps: [`critic failed: ${message}`] };
        }
      }
      const canRepair =
        verdict !== undefined && !verdict.passed && repairCount < this.repairRounds;
      if (canRepair) {
        emit({
          type: "task_ended",
          timestamp: nowIso(),
          runId,
          taskId: task.id,
          data: { status: "repair_scheduled", durationMs, repair: repairCount + 1 },
        });
        const repairedTask: SubagentTask = {
          ...task,
          context: `${task.context ?? ""}\nREPAIR GAPS:\n${verdict?.gaps.join("\n") ?? ""}`.trim(),
        };
        repairCounts.set(task.id, repairCount + 1);
        // Pipeline semantics: repaired task goes to the FRONT (priority).
        pending.unshift(repairedTask);
        return;
      }
      let finalResult = result;
      if (repairCount > 0) {
        finalResult = { ...result, summary: `[repair ${repairCount}] ${result.summary}` };
      }
      reports.set(task.id, {
        task,
        result: finalResult,
        ...(verdict ? { critic: verdict } : {}),
      });
      emit({
        type: "task_ended",
        timestamp: nowIso(),
        runId,
        taskId: task.id,
        data: { status: finalResult.status, durationMs },
      });
      emit({
        type: "latency",
        timestamp: nowIso(),
        runId,
        taskId: task.id,
        data: { scope: "task", durationMs },
      });
    };

    const runOne = async (task: SubagentTask, repairCount: number): Promise<void> => {
      emit({ type: "task_started", timestamp: nowIso(), runId, taskId: task.id, data: { repair: repairCount } });
      const t0 = Date.now();
      let result: SubagentResult;
      try {
        result = await this.spawn(task);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        result = { taskId: task.id, status: "fail", summary: `spawn failed: ${message}`, artifacts: [] };
      }
      await processResult(task, result, Date.now() - t0, repairCount);
    };

    await new Promise<void>((resolveAll) => {
      const pump = (): void => {
        if (this.signal?.aborted) {
          // Mark everything never started as aborted-fail.
          while (index < pending.length) {
            const t = pending[index];
            index += 1;
            if (t && !reports.has(t.id)) {
              reports.set(t.id, {
                task: t,
                result: { taskId: t.id, status: "fail", summary: "aborted", artifacts: [] },
              });
            }
          }
          if (inFlight === 0) resolveAll();
          return;
        }
        while (index < pending.length && inFlight < this.maxConcurrency) {
          const task = pending[index];
          index += 1;
          if (!task) continue;
          inFlight += 1;
          const repairCount = repairCounts.get(task.id) ?? 0;
          void runOne(task, repairCount)
            .catch(() => undefined)
            .finally(() => {
              inFlight -= 1;
              if (inFlight === 0 && index >= pending.length) {
                resolveAll();
              } else {
                pump();
              }
            });
        }
        if (inFlight === 0 && index >= pending.length) resolveAll();
      };
      pump();
    });

    const ordered = plan.subtasks.map((t) => {
      const found = reports.get(t.id);
      return (
        found ?? {
          task: t,
          result: { taskId: t.id, status: "fail" as const, summary: "aborted", artifacts: [] },
        }
      );
    });
    return {
      goal: plan.goal,
      completedAt: nowIso(),
      subtasks: ordered,
      allPassed: ordered.every((r) => r.result.status === "pass" && (r.critic?.passed ?? true)),
      totalDurationMs: Date.now() - startedAt,
    };
  }
}
