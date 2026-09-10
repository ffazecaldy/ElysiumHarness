import { describe, expect, it } from "vitest";
import {
  EventBus,
  MockProvider,
  ProviderRegistry,
  QualityGate,
  createDefaultRubric,
  makeEvent,
  structuralJudge,
  type LlmRequest,
} from "@elysium/core";

const baseRequest: LlmRequest = {
  systemPrompt: "sys",
  messages: [{ role: "user", content: "hello world" }],
  tools: [],
};

describe("MockProvider", () => {
  it("streams text deltas per word and ends with end_turn", async () => {
    const provider = new MockProvider([{ text: "hello brave world" }]);
    const events = [];
    for await (const ev of provider.stream(baseRequest)) events.push(ev);
    const deltas = events.filter((e) => e.type === "text_delta");
    expect(deltas.length).toBe(3);
    const done = events.find((e) => e.type === "done");
    expect(done && done.type === "done").toBe(true);
    if (done?.type === "done") {
      expect(done.message.stopReason).toBe("end_turn");
      expect(done.message.text).toBe("hello brave world");
      expect(done.message.toolCalls).toHaveLength(0);
      expect(done.message.usage?.inputTokens).toBeGreaterThan(0);
    }
  });

  it("emits tool_call events and sets stopReason tool_use", async () => {
    const provider = new MockProvider([
      { toolCalls: [{ name: "read", arguments: { path: "a.txt" } }] },
    ]);
    const events = [];
    for await (const ev of provider.stream(baseRequest)) events.push(ev);
    expect(events.some((e) => e.type === "tool_call_start")).toBe(true);
    const done = events.find((e) => e.type === "done");
    if (done?.type === "done") {
      expect(done.message.stopReason).toBe("tool_use");
      expect(done.message.toolCalls[0]?.name).toBe("read");
      expect(done.message.toolCalls[0]?.arguments).toEqual({ path: "a.txt" });
    }
  });

  it("consumes the script FIFO and throws when exhausted", async () => {
    const provider = new MockProvider([{ text: "one" }, { text: "two" }]);
    for await (const _ of provider.stream(baseRequest)) void _;
    for await (const _ of provider.stream(baseRequest)) void _;
    await expect(async () => {
      for await (const _ of provider.stream(baseRequest)) void _;
    }).rejects.toThrow("mock provider script exhausted");
  });

  it("throws immediately when the signal is already aborted", async () => {
    const provider = new MockProvider([{ text: "x" }]);
    const controller = new AbortController();
    controller.abort();
    await expect(async () => {
      for await (const _ of provider.stream({ ...baseRequest, signal: controller.signal })) void _;
    }).rejects.toThrow();
  });

  it("supports function scripts with per-request turns", async () => {
    const provider = new MockProvider((req) => ({
      text: `echo:${(req.messages[0] as { content: string }).content}`,
    }));
    for await (const ev of provider.stream(baseRequest)) {
      if (ev.type === "done") expect(ev.message.text).toBe("echo:hello world");
    }
  });
});

describe("ProviderRegistry", () => {
  it("rejects duplicate ids and resolves by id", () => {
    const registry = new ProviderRegistry();
    registry.register(new MockProvider([{ text: "a" }]));
    expect(() => registry.register(new MockProvider([{ text: "b" }]))).toThrow(/already registered/);
    expect(registry.get("mock")).toBeDefined();
    expect(registry.get("nope")).toBeUndefined();
    expect(registry.list()).toHaveLength(1);
  });
});

describe("EventBus", () => {
  it("delivers to handlers in registration order and supports unsubscribe", () => {
    const bus = new EventBus();
    const order: string[] = [];
    const off1 = bus.on(() => order.push("first"));
    bus.on(() => order.push("second"));
    bus.emit(makeEvent("custom", {}));
    expect(order).toEqual(["first", "second"]);
    off1();
    bus.emit(makeEvent("custom", {}));
    expect(order).toEqual(["first", "second", "second"]);
  });

  it("contains handler errors as error events without looping", () => {
    const bus = new EventBus();
    bus.on((e) => {
      if (e.type === "custom") throw new Error("boom");
    });
    const seen: string[] = [];
    bus.on((e) => seen.push(e.type));
    bus.emit(makeEvent("custom", {}));
    expect(seen).toContain("error");
    const errors = bus.recent(10).filter((e) => e.type === "error");
    expect(errors.length).toBe(1);
    expect(errors[0]?.data).toMatchObject({ message: "boom", scope: "event_handler" });
  });

  it("keeps recent(n) oldest-first within the ring bound", () => {
    const bus = new EventBus({ bufferSize: 3 });
    for (let i = 0; i < 5; i++) bus.emit(makeEvent("custom", { i }));
    expect(bus.recent(10).map((e) => (e.data as { i: number }).i)).toEqual([2, 3, 4]);
    bus.clear();
    expect(bus.recent(10)).toHaveLength(0);
  });
});

describe("QualityGate", () => {
  const rubric = createDefaultRubric();

  it("weights sum to 1", () => {
    const sum = rubric.dimensions.reduce((a, d) => a + d.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
  });

  it("accepts a substantive artifact covering its criteria", async () => {
    const gate = new QualityGate();
    const score = await gate.evaluate(
      {
        kind: "code",
        content: "x".repeat(400) + " implements the registry and the policy engine and depth validation",
        criteria: ["registry", "policy engine", "depth validation"],
      },
      rubric,
    );
    expect(score.passed).toBe(true);
    expect(score.weighted).toBeGreaterThanOrEqual(8);
    expect(score.reasons).toHaveLength(0);
  });

  it("rejects filler-laden content with actionable reasons", async () => {
    const gate = new QualityGate();
    const score = await gate.evaluate(
      {
        kind: "code",
        content: `${"TODO fix this placeholder lorem\n".repeat(10)}short`,
        criteria: ["real implementation"],
      },
      rubric,
    );
    expect(score.passed).toBe(false);
    expect(score.reasons.length).toBeGreaterThan(0);
    expect(score.weighted).toBeLessThan(8);
  });

  it("normalizes weights that do not sum to 1", async () => {
    const gate = new QualityGate({ judge: structuralJudge });
    const score = await gate.evaluate(
      { kind: "code", content: "y".repeat(300) },
      {
        id: "wonky",
        threshold: 8,
        dimensions: [
          { name: "a", weight: 5, instruction: "a" },
          { name: "b", weight: 5, instruction: "b" },
        ],
      },
    );
    const weightSum = score.dimensions.reduce((acc, d) => acc + d.weight, 0);
    expect(weightSum).toBeCloseTo(1, 6);
  });
});
