/**
 * Deterministic scripted provider — tests, benchmarks, offline demo.
 * Zero network, zero I/O, fully reproducible.
 */
import type {
  AssistantMessage,
  TokenUsage,
} from "../types/messages";
import type {
  LlmProvider,
  LlmRequest,
  ScriptedToolCall,
  ScriptedTurn,
  StreamEvent,
  ToolDefinition,
} from "../types/provider";

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateRequestTokens(request: LlmRequest): number {
  const parts: string[] = [request.systemPrompt];
  for (const m of request.messages) {
    if (m.role === "user") parts.push(m.content);
    else if (m.role === "assistant") parts.push(m.text);
    else parts.push(m.content);
  }
  for (const t of request.tools) parts.push(t.name, t.description);
  return estimateTokens(parts.join(" "));
}

export class MockProvider implements LlmProvider {
  readonly id = "mock";
  private readonly script: ScriptedTurn[] | ((req: LlmRequest) => ScriptedTurn);
  private queue: ScriptedTurn[];

  constructor(script: ScriptedTurn[] | ((req: LlmRequest) => ScriptedTurn)) {
    this.script = script;
    this.queue = Array.isArray(script) ? [...script] : [];
  }

  async *stream(request: LlmRequest): AsyncGenerator<StreamEvent> {
    if (request.signal?.aborted) {
      throw new Error("request aborted before start");
    }
    const turn = Array.isArray(this.script)
      ? this.queue.shift()
      : this.script(request);
    if (!turn) {
      throw new Error("mock provider script exhausted");
    }
    const toolCalls: ScriptedToolCall[] = turn.toolCalls ?? [];
    const text = turn.text ?? "";
    let n = 0;
    if (text.length > 0) {
      for (const word of text.split(/\s+/).filter((w) => w.length > 0)) {
        yield { type: "text_delta", delta: `${word} ` };
        n += word.length + 1;
      }
    }
    let i = 0;
    for (const call of toolCalls) {
      i += 1;
      const id = call.id ?? `tc_${i}`;
      yield { type: "tool_call_start", id, name: call.name };
      yield {
        type: "tool_call_delta",
        id,
        argumentsDelta: JSON.stringify(call.arguments),
      };
      n += id.length + call.name.length;
    }
    const usage: TokenUsage = turn.usage ?? {
      inputTokens: estimateRequestTokens(request),
      outputTokens: Math.ceil(n / 4),
    };
    const message: AssistantMessage = {
      role: "assistant",
      text,
      toolCalls: toolCalls.map((c, idx) => ({
        type: "tool_call" as const,
        id: c.id ?? `tc_${idx + 1}`,
        name: c.name,
        arguments: c.arguments,
      })),
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage,
    };
    yield { type: "done", message };
  }
}
