/**
 * OpenAI-compatible streaming provider (Chat Completions, SSE).
 * Works with any OpenAI-compatible endpoint (OpenAI, Azure, local gateways).
 * The API key is used only in the Authorization header — never logged, never exposed.
 */
import type { AgentMessage, AssistantMessage } from "../types/messages";
import type { LlmProvider, LlmRequest, StreamEvent, ToolDefinition } from "../types/provider";

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

interface OpenAiToolCallFragment {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: OpenAiToolCallFragment[];
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function messageToOpenAi(m: AgentMessage): Record<string, unknown> {
  if (m.role === "user") {
    return { role: "user", content: m.content };
  }
  if (m.role === "assistant") {
    const content =
      m.text ||
      m.toolCalls.map((c) => `[tool_call ${c.name}(${JSON.stringify(c.arguments)})]`).join(" ");
    return { role: "assistant", content };
  }
  return { role: "user", content: `[tool_result for ${m.toolName}] ${m.content}` };
}

function toolsToOpenAi(tools: ToolDefinition[]): Record<string, unknown>[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

interface AssembledCall {
  id: string;
  name: string;
  arguments: string;
}

/**
 * The API key lives in a module-level WeakMap instead of an instance
 * property: TypeScript `private` is compile-time only, and a plain field
 * would leak through JSON.stringify(provider) or Object.entries().
 */
const apiKeys = new WeakMap<OpenAICompatibleProvider, string>();

export class OpenAICompatibleProvider implements LlmProvider {
  readonly id = "openai-compatible";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAICompatibleOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    apiKeys.set(this, options.apiKey);
    this.model = options.model;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  async *stream(request: LlmRequest): AsyncGenerator<StreamEvent> {
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        ...request.messages.map(messageToOpenAi),
      ],
      ...(request.tools.length > 0 ? { tools: toolsToOpenAi(request.tools) } : {}),
      stream: true,
      stream_options: { include_usage: true },
    };
    const apiKey = apiKeys.get(this) ?? "";
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        ...(request.signal ? { signal: request.signal } : {}),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: new Error(`openai-compatible request failed: ${message}`) };
      return;
    }
    if (!response.ok || !response.body) {
      const excerpt = (await response.text().catch(() => "")).slice(0, 500);
      yield {
        type: "error",
        error: new Error(`openai-compatible HTTP ${response.status}: ${excerpt}`),
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    const calls = new Map<number, AssembledCall>();
    let usage: { inputTokens: number; outputTokens: number } | null = null;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") continue;
          let chunk: OpenAiChunk;
          try {
            chunk = JSON.parse(payload) as OpenAiChunk;
          } catch {
            continue; // tolerate keep-alives / partial frames
          }
          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }
          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === "string" && delta.content.length > 0) {
            text += delta.content;
            yield { type: "text_delta", delta: delta.content };
          }
          for (const fragment of delta.tool_calls ?? []) {
            const existing = calls.get(fragment.index) ?? { id: "", name: "", arguments: "" };
            if (fragment.id) existing.id = fragment.id;
            if (fragment.function?.name) {
              existing.name = fragment.function.name;
              yield {
                type: "tool_call_start",
                id: existing.id || `tc_${fragment.index}`,
                name: existing.name,
              };
            }
            if (fragment.function?.arguments) {
              existing.arguments += fragment.function.arguments;
              yield {
                type: "tool_call_delta",
                id: existing.id || `tc_${fragment.index}`,
                argumentsDelta: fragment.function.arguments,
              };
            }
            calls.set(fragment.index, existing);
          }
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", error: new Error(`openai-compatible stream failed: ${message}`) };
      return;
    }

    const toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, c]): AssistantMessage["toolCalls"][number] => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }
        return { type: "tool_call" as const, id: c.id, name: c.name, arguments: args };
      });
    const message: AssistantMessage = {
      role: "assistant",
      text,
      toolCalls,
      stopReason: toolCalls.length > 0 ? "tool_use" : "end_turn",
      usage: usage ?? { inputTokens: 0, outputTokens: 0 },
    };
    yield { type: "done", message };
  }
}
