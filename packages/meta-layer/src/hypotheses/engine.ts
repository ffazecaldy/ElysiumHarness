/**
 * Hypothesis engine: observe aggregates -> propose controlled config deltas
 * -> apply -> measure on held-out re-runs -> promote only positive deltas.
 */
import { randomUUID } from "node:crypto";
import type { HarnessEvent } from "@elysium/core";
import type { Hypothesis, HypothesisChange, Observation } from "../types";

export interface HypothesisEngineOptions {
  /** Propose when first_pass_rate over the window falls below this. Default 0.7. */
  firstPassThreshold?: number;
  /** Propose when average task latency exceeds this (ms). Default 30000. */
  latencyThresholdMs?: number;
  /** Minimum window (task_ended events) before proposing. Default 5. */
  minWindow?: number;
}

/** Orchestration config knobs a hypothesis may change (data, never code). */
export interface OrchestrationConfig {
  repairRounds: number;
  maxConcurrency: number;
}

const VALID_KINDS = ["retry_policy", "decomposition_granularity", "tool_ordering", "max_concurrency"] as const;

export function isValidChange(change: HypothesisChange): boolean {
  return (VALID_KINDS as readonly string[]).includes(change.kind);
}

function nowIso(): string {
  return new Date().toISOString();
}

export class HypothesisEngine {
  private readonly firstPassThreshold: number;
  private readonly latencyThresholdMs: number;
  private readonly minWindow: number;
  private readonly hypotheses = new Map<string, Hypothesis>();

  constructor(options?: HypothesisEngineOptions) {
    this.firstPassThreshold = options?.firstPassThreshold ?? 0.7;
    this.latencyThresholdMs = options?.latencyThresholdMs ?? 30000;
    this.minWindow = options?.minWindow ?? 5;
  }

  observe(events: HarnessEvent[]): Hypothesis[] {
    const proposed: Hypothesis[] = [];
    const ended = events.filter((e) => e.type === "task_ended");
    if (ended.length === 0) return proposed;
    const window = ended.length;
    const passes = ended.filter((e) => (e.data as { status?: string }).status === "pass").length;
    const firstPass = window > 0 ? passes / window : 1;
    const latencies = events
      .filter((e) => e.type === "latency" && (e.data as { scope?: string }).scope === "task")
      .map((e) => (e.data as { durationMs: number }).durationMs);
    const avgLatency =
      latencies.length > 0
        ? latencies.reduce((a, b) => a + b, 0) / latencies.length
        : 0;

    const make = (observation: Observation, change: HypothesisChange, expectedEffect: string): Hypothesis => {
      const hyp: Hypothesis = {
        id: `hyp_${randomUUID()}`,
        observation,
        change,
        expectedEffect,
        status: "proposed",
        delta: null,
      };
      this.hypotheses.set(hyp.id, hyp);
      proposed.push(hyp);
      return hyp;
    };

    if (window >= this.minWindow && firstPass < this.firstPassThreshold) {
      make(
        { metric: "first_pass_rate", value: firstPass, window },
        { kind: "retry_policy", from: { repairRounds: 1 }, to: { repairRounds: 2 } },
        "first_pass_rate +0.05 or more on held-out re-run",
      );
    }
    if (latencies.length >= this.minWindow && avgLatency > this.latencyThresholdMs) {
      make(
        { metric: "avg_task_latency_ms", value: avgLatency, window: latencies.length },
        { kind: "max_concurrency", from: { maxConcurrency: 4 }, to: { maxConcurrency: 8 } },
        "avg_task_latency_ms -20% or more on held-out re-run",
      );
    }
    return proposed;
  }

  list(): Hypothesis[] {
    return [...this.hypotheses.values()];
  }

  get(id: string): Hypothesis | undefined {
    return this.hypotheses.get(id);
  }

  markApplied(id: string): void {
    const h = this.hypotheses.get(id);
    if (!h) throw new Error(`hypothesis not found: ${id}`);
    h.status = "applied";
  }

  markPromoted(id: string, delta: number): void {
    const h = this.hypotheses.get(id);
    if (!h) throw new Error(`hypothesis not found: ${id}`);
    h.status = "promoted";
    h.delta = delta;
  }

  markRejected(id: string, delta: number): void {
    const h = this.hypotheses.get(id);
    if (!h) throw new Error(`hypothesis not found: ${id}`);
    h.status = "rejected";
    h.delta = delta;
  }
}

export function hypothesisTimestamp(): string {
  return nowIso();
}
