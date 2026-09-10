/**
 * Meta-Layer closed loop: subscribe to the core event bus -> persist
 * telemetry -> periodically propose hypotheses -> apply under control ->
 * measure delta on held-out re-run -> promote only positive deltas.
 */
import type { EventBus, HarnessEvent } from "@elysium/core";
import { TelemetryStore } from "./store/telemetry-store";
import { HypothesisEngine, type OrchestrationConfig } from "./hypotheses/engine";
import type { Hypothesis } from "./types";

export interface MetaLayerOptions {
  store: TelemetryStore;
  engine: HypothesisEngine;
  /** Current controlled orchestration config. */
  config: OrchestrationConfig;
  /** Apply a config change (the ONLY mutation path — data, never code). */
  applyConfig(next: OrchestrationConfig): Promise<void>;
  /** Re-run the held-out benchmark set; returns the same metric as the observation. */
  measure(metric: string): Promise<number>;
  /** Hypotheses are evaluated every N persisted task_ended events. Default 20. */
  evaluationInterval?: number;
}

export interface MetaLayerStats {
  persisted: number;
  hypothesesProposed: number;
  promoted: number;
  rejected: number;
}

type Unsubscribe = () => void;

/** For latency-like metrics lower is better; for rates higher is better. */
function isImprovement(metric: string, delta: number): boolean {
  return metric === "avg_task_latency_ms" ? delta < 0 : delta > 0;
}

export class MetaLayer {
  private readonly store: TelemetryStore;
  private readonly engine: HypothesisEngine;
  private config: OrchestrationConfig;
  private readonly applyConfig: (next: OrchestrationConfig) => Promise<void>;
  private readonly measure: (metric: string) => Promise<number>;
  private readonly evaluationInterval: number;
  private readonly pending: HarnessEvent[] = [];
  private stats: MetaLayerStats = { persisted: 0, hypothesesProposed: 0, promoted: 0, rejected: 0 };
  private unsubscribe: Unsubscribe | null = null;
  /** Serialized evaluation chain: auto-triggered and explicit evaluations never interleave. */
  private chain: Promise<void> = Promise.resolve();

  constructor(options: MetaLayerOptions) {
    this.store = options.store;
    this.engine = options.engine;
    this.config = { ...options.config };
    this.applyConfig = options.applyConfig;
    this.measure = options.measure;
    this.evaluationInterval = options.evaluationInterval ?? 20;
  }

  /** Attach to an event bus. Returns the detach function. */
  attach(bus: EventBus): Unsubscribe {
    this.detach();
    this.unsubscribe = bus.on((event: HarnessEvent) => {
      this.store.append(event);
      this.stats.persisted += 1;
      if (event.type === "task_ended") {
        this.pending.push(event);
        if (this.pending.length >= this.evaluationInterval) {
          this.chain = this.chain.then(() => this.runEvaluation());
        }
      }
    });
    return this.unsubscribe;
  }

  detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** Evaluate accumulated task_ended events; serialized, awaited by callers. */
  async evaluateNow(): Promise<void> {
    this.chain = this.chain.then(() => this.runEvaluation());
    await this.chain;
  }

  /** Awaits any in-flight or queued evaluation (drains the chain). */
  async whenIdle(): Promise<void> {
    await this.chain;
  }

  private async runEvaluation(): Promise<void> {
    if (this.pending.length === 0) return;
    const events = this.pending.splice(0, this.pending.length);
    const proposed = this.engine.observe(events);
    this.stats.hypothesesProposed += proposed.length;
    for (const hyp of proposed) {
      const before = await this.measure(hyp.observation.metric);
      const next = this.nextConfig(hyp);
      await this.applyConfig(next);
      this.engine.markApplied(hyp.id);
      const after = await this.measure(hyp.observation.metric);
      const delta = after - before;
      if (isImprovement(hyp.observation.metric, delta)) {
        this.engine.markPromoted(hyp.id, delta);
        this.stats.promoted += 1;
        this.config = next;
      } else {
        // Roll back to the previous config.
        await this.applyConfig(this.config);
        this.engine.markRejected(hyp.id, delta);
        this.stats.rejected += 1;
      }
    }
  }

  private nextConfig(hyp: Hypothesis): OrchestrationConfig {
    const next = { ...this.config };
    if (hyp.change.kind === "retry_policy" && typeof hyp.change.to["repairRounds"] === "number") {
      next.repairRounds = hyp.change.to["repairRounds"] as number;
    }
    if (hyp.change.kind === "max_concurrency" && typeof hyp.change.to["maxConcurrency"] === "number") {
      next.maxConcurrency = hyp.change.to["maxConcurrency"] as number;
    }
    return next;
  }

  currentConfig(): OrchestrationConfig {
    return { ...this.config };
  }

  getStats(): MetaLayerStats {
    return { ...this.stats };
  }
}
