import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBus, makeEvent } from "@elysium/core";
import type { HarnessEvent } from "@elysium/core";
import { describe, expect, it } from "vitest";
import { HypothesisEngine } from "../src/hypotheses/engine";
import { MetaLayer } from "../src/loop";
import { TelemetryStore } from "../src/store/telemetry-store";

function taskEnded(status: string, taskId: string): HarnessEvent {
  return makeEvent("task_ended", { status }, { runId: "run-1", taskId });
}

function latency(ms: number, taskId: string): HarnessEvent {
  return makeEvent("latency", { scope: "task", durationMs: ms }, { runId: "run-1", taskId });
}

describe("TelemetryStore", () => {
  it("persists JSONL verbatim and reloads", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ml-")), "t.jsonl");
    const s1 = new TelemetryStore({ filePath: file });
    s1.append(taskEnded("pass", "t1"));
    s1.append(latency(100, "t1"));
    expect(s1.size()).toBe(2);
    const s2 = new TelemetryStore({ filePath: file });
    expect(s2.size()).toBe(2);
    expect(s2.query({ type: "latency" })).toHaveLength(1);
    expect(s2.query({ taskId: "t1", type: "task_ended" })).toHaveLength(1);
    expect(s2.query({ taskId: "t2" })).toHaveLength(0);
  });

  it("filters by time window", () => {
    const s = new TelemetryStore({
      filePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ml-")), "t.jsonl"),
    });
    const e1 = taskEnded("pass", "a");
    e1.timestamp = "2026-01-01T00:00:00.000Z";
    const e2 = taskEnded("fail", "b");
    e2.timestamp = "2026-06-01T00:00:00.000Z";
    s.append(e1);
    s.append(e2);
    expect(s.query({ since: "2026-03-01T00:00:00.000Z" })).toHaveLength(1);
    expect(s.query({ until: "2026-03-01T00:00:00.000Z" })).toHaveLength(1);
  });
});

describe("HypothesisEngine", () => {
  it("proposes nothing below the minimum window", () => {
    const engine = new HypothesisEngine({ minWindow: 5 });
    const events = [taskEnded("fail", "t1"), taskEnded("fail", "t2")];
    expect(engine.observe(events)).toHaveLength(0);
  });

  it("proposes a retry-policy hypothesis when first-pass rate is low", () => {
    const engine = new HypothesisEngine({ minWindow: 5 });
    const events: HarnessEvent[] = [];
    for (let i = 0; i < 10; i++) {
      events.push(taskEnded(i < 4 ? "pass" : "fail", `t${i}`));
    }
    const proposed = engine.observe(events);
    expect(proposed.length).toBeGreaterThanOrEqual(1);
    expect(proposed[0]?.change.kind).toBe("retry_policy");
    expect(proposed[0]?.observation.metric).toBe("first_pass_rate");
    expect(proposed[0]?.status).toBe("proposed");
  });

  it("proposes a concurrency hypothesis when latency is high", () => {
    const engine = new HypothesisEngine({ minWindow: 3, latencyThresholdMs: 1000 });
    const events: HarnessEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(taskEnded("pass", `t${i}`));
      events.push(latency(5000, `t${i}`));
    }
    const proposed = engine.observe(events);
    expect(proposed.some((h) => h.change.kind === "max_concurrency")).toBe(true);
  });

  it("marks transitions with delta values", () => {
    const engine = new HypothesisEngine(); // default minWindow: 5
    const proposed = engine.observe([taskEnded("fail", "x")]);
    expect(proposed).toHaveLength(0); // below the minimum window
    const h = engine.observe([
      taskEnded("fail", "a"),
      taskEnded("fail", "b"),
      taskEnded("fail", "c"),
      taskEnded("pass", "d"),
      taskEnded("fail", "e"),
    ]);
    expect(h.length).toBe(1);
    const id = h[0]?.id ?? "";
    engine.markApplied(id);
    engine.markPromoted(id, 0.12);
    const stored = engine.get(id);
    expect(stored?.status).toBe("promoted");
    expect(stored?.delta).toBe(0.12);
  });
});

describe("MetaLayer closed loop", () => {
  it("persists bus events, proposes, applies, promotes only positive deltas", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-"));
    const store = new TelemetryStore({ filePath: path.join(dir, "t.jsonl") });
    const engine = new HypothesisEngine({ minWindow: 5 });
    let config = { repairRounds: 1, maxConcurrency: 4 };
    const applied: Array<{ repairRounds: number; maxConcurrency: number }> = [];
    // Deterministic measurement: first-pass rate improves when repairRounds = 2.
    const measure = async (metric: string): Promise<number> => {
      if (metric !== "first_pass_rate") return 0;
      return config.repairRounds >= 2 ? 0.8 : 0.5;
    };
    const meta = new MetaLayer({
      store,
      engine,
      config,
      evaluationInterval: 1000, // no auto-trigger on this path
      applyConfig: async (next) => {
        config = next;
        applied.push({ ...next });
      },
      measure,
    });
    const bus = new EventBus();
    meta.attach(bus);

    // Feed 10 failing-ish tasks through the real bus, then evaluate explicitly.
    for (let i = 0; i < 10; i++) {
      bus.emit(taskEnded("fail", `t${i}`));
    }
    await meta.evaluateNow();

    const stats = meta.getStats();
    expect(stats.persisted).toBeGreaterThanOrEqual(10);
    expect(stats.hypothesesProposed).toBeGreaterThanOrEqual(1);
    expect(config.repairRounds).toBe(2);
    expect(stats.promoted).toBeGreaterThanOrEqual(1);
    const promoted = engine.list().filter((h) => h.status === "promoted");
    expect(promoted.length).toBeGreaterThanOrEqual(1);
    void applied;
  });

  it("rolls back when the delta is not positive", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-"));
    const store = new TelemetryStore({ filePath: path.join(dir, "t.jsonl") });
    const engine = new HypothesisEngine({ minWindow: 5 });
    let config = { repairRounds: 1, maxConcurrency: 4 };
    const meta = new MetaLayer({
      store,
      engine,
      config,
      evaluationInterval: 5,
      applyConfig: async (next) => {
        config = next;
      },
      measure: async () => 0.5, // constant -> delta 0 -> reject + rollback
    });
    const bus = new EventBus();
    meta.attach(bus);
    for (let i = 0; i < 6; i++) {
      bus.emit(taskEnded("fail", `t${i}`));
    }
    await meta.evaluateNow();
    expect(config.repairRounds).toBe(1); // rolled back
    expect(engine.list().some((h) => h.status === "rejected")).toBe(true);
  });
});
