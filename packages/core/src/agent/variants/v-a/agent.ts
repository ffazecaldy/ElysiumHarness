/**
 * Agent Loop — VARIANT A (rich class).
 * A single stateful class owning the full turn engine with explicit
 * snapshot semantics: every LLM request is built once per turn from an
 * immutable snapshot; setter calls apply from the NEXT turn only.
 */
import type { ToolCallPart } from "../../../types/content";
import type {
  AgentMessage,
  AssistantMessage,
  StopReason,
  TokenUsage,
  ToolResultMessage,
} from "../../../types/messages";
import type { LlmProvider } from "../../../types/provider";
import type { Tool } from "../../../types/tools";

export interface AgentOptions {
  systemPrompt: string;
  provider: LlmProvider;
  tools?: Tool[];
  maxTurns?: number;
  signal?: AbortSignal;
  /**
   * Seam for tool execution. The core loop never executes tools itself;
   * the host wires a real executor (ToolRegistry) in.
   */
  executeTool?: (call: ToolCallPart, ctx: { signal: AbortSignal }) => Promise<ToolResultMessage>;
}

export interface TurnResult {
  messages: AgentMessage[];
  stopReason: StopReason;
  turns: number;
  usage: TokenUsage;
}

interface TurnSnapshot {
  systemPrompt: string;
  tools: Tool[];
}

function emptyUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  return {
    inputTokens: a.inputTokens + (b?.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b?.outputTokens ?? 0),
  };
}

export class Agent {
  private readonly provider: LlmProvider;
  private readonly maxTurns: number;
  private readonly signal: AbortSignal | undefined;
  private readonly executeToolFn: NonNullable<AgentOptions["executeTool"]>;
  /** Pending snapshot changes: applied to the snapshot used by the NEXT turn. */
  private pendingSystemPrompt: string | null = null;
  private pendingTools: Tool[] | null = null;
  private readonly steerQueue: string[] = [];
  private aborted = false;

  constructor(options: AgentOptions) {
    this.provider = options.provider;
    this.maxTurns = options.maxTurns ?? 8;
    this.signal = options.signal;
    this.initialSystemPrompt = options.systemPrompt;
    if (options.executeTool) {
      this.executeToolFn = options.executeTool;
    } else {
      this.executeToolFn = async () => {
        throw new Error("no tool executor configured");
      };
    }
  }

  setSystemPrompt(p: string): void {
    this.pendingSystemPrompt = p;
  }

  setTools(tools: Tool[]): void {
    this.pendingTools = [...tools];
  }

  /** Queue a user message; delivered between turns. */
  steer(text: string): void {
    this.steerQueue.push(text);
  }

  abort(): void {
    this.aborted = true;
  }

  async run(prompt: string): Promise<TurnResult> {
    if (prompt.trim().length === 0) {
      throw new Error("prompt must not be empty");
    }
    let snapshot: TurnSnapshot = {
      systemPrompt: this.pendingSystemPrompt ?? this.initialSystemPrompt,
      tools: this.pendingTools ?? [],
    };
    this.pendingSystemPrompt = null;
    this.pendingTools = null;

    const messages: AgentMessage[] = [{ role: "user", content: prompt }];
    for (const s of this.steerQueue) {
      messages.push({ role: "user", content: s });
    }
    this.steerQueue.length = 0;

    const usage = emptyUsage();
    let stopReason: StopReason = "end_turn";
    let turns = 0;

    while (true) {
      if (this.aborted || this.signal?.aborted) {
        stopReason = "aborted";
        break;
      }
      turns += 1;
      if (turns > this.maxTurns) {
        throw new Error("max turns exceeded");
      }
      const request = {
        systemPrompt: snapshot.systemPrompt,
        messages: [...messages],
        tools: snapshot.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        ...(this.signal ? { signal: this.signal } : {}),
      };
      const assistant = await this.consumeStream(request, messages);
      usage.inputTokens += assistant.usage?.inputTokens ?? 0;
      usage.outputTokens += assistant.usage?.outputTokens ?? 0;
      messages.push(assistant);
      if (assistant.stopReason !== "tool_use" || assistant.toolCalls.length === 0) {
        stopReason = assistant.stopReason;
        break;
      }
      for (const call of assistant.toolCalls) {
        const result = await this.executeToolFn(call, {
          signal: this.signal ?? new AbortController().signal,
        });
        messages.push(result);
      }
      // Drain steering between turns.
      for (const s of this.steerQueue) {
        messages.push({ role: "user", content: s });
      }
      this.steerQueue.length = 0;
      // Snapshot refresh: pending setters now take effect for the next turn.
      snapshot = {
        systemPrompt: this.pendingSystemPrompt ?? snapshot.systemPrompt,
        tools: this.pendingTools ?? snapshot.tools,
      };
      this.pendingSystemPrompt = null;
      this.pendingTools = null;
    }
    return { messages, stopReason, turns, usage };
  }

  private initialSystemPrompt: string;

  private async consumeStream(
    request: Parameters<LlmProvider["stream"]>[0],
    messages: AgentMessage[],
  ): Promise<AssistantMessage> {
    let text = "";
    let done: AssistantMessage | null = null;
    try {
      for await (const ev of this.provider.stream(request)) {
        if (this.aborted || this.signal?.aborted) {
          return {
            role: "assistant",
            text,
            toolCalls: [],
            stopReason: "aborted",
            ...(done?.usage ? { usage: done.usage } : {}),
          };
        }
        if (ev.type === "text_delta") {
          text += ev.delta;
        } else if (ev.type === "done") {
          done = ev.message;
        } else if (ev.type === "error") {
          throw ev.error;
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`provider stream failed: ${message}`);
    }
    if (!done) {
      throw new Error("provider stream ended without a done event");
    }
    return done;
  }
}

export function isToolCallPart(x: unknown): x is ToolCallPart {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as Record<string, unknown>)["type"] === "tool_call"
  );
}
