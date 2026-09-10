/**
 * Agent loop — Variant C: functional state machine.
 *
 * The loop is implemented as pure state transitions (`createAgentState` +
 * `stepTurn`) so it can be driven and tested without the `Agent` class; the
 * `Agent` class is a thin wrapper that owns abort wiring and the run
 * lifecycle around the state machine.
 *
 * Behavior contract (docs/architecture.md §2, Agent Loop):
 * - Runs prompt -> provider stream -> sequential tool executions -> repeat
 *   until `end_turn`/`aborted`; exceeding `maxTurns` throws
 *   Error("max turns exceeded").
 * - Per-turn snapshot: the provider request is built once per turn from the
 *   state values read at turn entry (system prompt, messages, tools); config
 *   changes made mid-turn apply to the *next* turn only.
 * - Steering: `steer()` queues user messages that are drained between turns
 *   (at the start of the next continuation turn, i.e. the next `stepTurn`
 *   call that receives a `null` prompt; an explicit prompt takes precedence
 *   and delays the drain by one turn).
 * - Abort: cooperative via `AbortSignal`. An aborted run returns a
 *   `TurnResult` with `stopReason: "aborted"` instead of throwing; tool
 *   calls that never ran because of an abort get synthetic error tool
 *   results so the transcript stays well-formed.
 * - Provider failures (a terminal `error` stream event, or a stream that
 *   ends without `done`) throw an Error with the cause attached.
 */

import type { ToolCallPart } from "../../../types/content";
import type {
  AgentMessage,
  AssistantMessage,
  StopReason,
  TokenUsage,
  ToolResultMessage,
  UserMessage,
} from "../../../types/messages";
import type { LlmProvider, LlmRequest, ToolDefinition } from "../../../types/provider";
import type { Tool } from "../../../types/tools";

/** Default provider-turn budget per run when `maxTurns` is omitted. */
export const DEFAULT_MAX_TURNS = 8;

/** Executes one tool call requested by the model and returns its result message. */
export type ToolExecutor = (
  call: ToolCallPart,
  ctx: { signal: AbortSignal },
) => Promise<ToolResultMessage>;

export interface AgentOptions {
  systemPrompt: string;
  provider: LlmProvider;
  tools?: Tool[];
  maxTurns?: number;
  signal?: AbortSignal;
  executeTool?: ToolExecutor;
}

/**
 * Mutable state of the agent loop. The five conversational fields
 * (`systemPrompt`, `messages`, `turnCount`, `steerQueue`, `aborted`) are the
 * loop's state proper; the remaining fields are the execution context that
 * `stepTurn` needs to reach the provider and the tool executor.
 */
export interface AgentState {
  systemPrompt: string;
  messages: AgentMessage[];
  turnCount: number;
  steerQueue: string[];
  aborted: boolean;
  /** Execution context (required by `stepTurn`, not conversational state). */
  provider: LlmProvider;
  tools: Tool[];
  maxTurns: number;
  signal?: AbortSignal;
  executeTool?: ToolExecutor;
  /** Stop reason of the most recent step; null until the first step completes. */
  stopReason: StopReason | null;
}

export interface TurnResult {
  messages: AgentMessage[];
  stopReason: StopReason;
  turns: number;
  usage: TokenUsage;
}

// ---- helpers ----

function assertNonEmptyText(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertUniqueToolNames(tools: readonly Tool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    seen.add(tool.name);
  }
}

function isAborted(state: AgentState): boolean {
  return state.aborted || state.signal?.aborted === true;
}

function toDefinitions(tools: readonly Tool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function createUserMessage(content: string): UserMessage {
  return { role: "user", content };
}

/**
 * Sentinel signal handed to tool executors when the state carries no signal,
 * so the executor always receives a live AbortSignal.
 */
const detachedToolSignal: AbortSignal = new AbortController().signal;

const defaultToolExecutor: ToolExecutor = async () => {
  throw new Error("no tool executor configured");
};

function drainSteerQueue(state: AgentState): void {
  while (state.steerQueue.length > 0) {
    const next = state.steerQueue.shift();
    if (next === undefined) {
      break;
    }
    state.messages.push(createUserMessage(next));
  }
}

function sumUsage(messages: readonly AgentMessage[]): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const message of messages) {
    if (message.role === "assistant" && message.usage !== undefined) {
      inputTokens += message.usage.inputTokens;
      outputTokens += message.usage.outputTokens;
    }
  }
  return { inputTokens, outputTokens };
}

/**
 * Consumes one provider stream and returns the assembled assistant message,
 * or null when the turn was aborted before a message was produced. The
 * progressive events (`text_delta`, `tool_call_start`, `tool_call_delta`)
 * carry no state here: the terminal `done` event holds the full message.
 */
async function streamAssistantMessage(
  state: AgentState,
  request: LlmRequest,
): Promise<AssistantMessage | null> {
  try {
    const stream = state.provider.stream(request);
    for await (const event of stream) {
      if (event.type === "done") {
        return event.message;
      }
      if (event.type === "error") {
        if (isAborted(state)) {
          return null;
        }
        throw new Error(`provider error: ${event.error.message}`, { cause: event.error });
      }
    }
    if (isAborted(state)) {
      return null;
    }
    throw new Error("provider stream ended without a terminal 'done' event");
  } catch (err) {
    if (isAborted(state)) {
      return null;
    }
    throw err;
  }
}

async function executeToolCalls(
  state: AgentState,
  request: LlmRequest,
  calls: readonly ToolCallPart[],
): Promise<void> {
  const executor = state.executeTool ?? defaultToolExecutor;
  const signal = request.signal ?? detachedToolSignal;
  state.stopReason = "tool_use";
  for (const call of calls) {
    if (isAborted(state)) {
      // Keep the transcript well-formed: every requested call gets a result.
      state.stopReason = "aborted";
      state.messages.push({
        role: "tool_result",
        toolCallId: call.id,
        toolName: call.name,
        content: "tool execution aborted before it ran",
        isError: true,
      });
      continue;
    }
    const result = await executor(call, { signal });
    state.messages.push(result);
  }
}

// ---- state machine (Variant C pure surface) ----

/** Validates the options and returns the initial agent state. */
export function createAgentState(options: AgentOptions): AgentState {
  if (typeof options.systemPrompt !== "string") {
    throw new Error("systemPrompt must be a string");
  }
  if (
    options.provider === undefined ||
    options.provider === null ||
    typeof options.provider.stream !== "function"
  ) {
    throw new Error("provider must be an LlmProvider with a stream(request) method");
  }
  if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns < 1)) {
    throw new Error("maxTurns must be a positive integer");
  }
  const tools = options.tools === undefined ? [] : [...options.tools];
  assertUniqueToolNames(tools);
  return {
    systemPrompt: options.systemPrompt,
    messages: [],
    turnCount: 0,
    steerQueue: [],
    aborted: options.signal?.aborted ?? false,
    provider: options.provider,
    tools,
    maxTurns: options.maxTurns ?? DEFAULT_MAX_TURNS,
    signal: options.signal,
    executeTool: options.executeTool,
    stopReason: null,
  };
}

/**
 * Advances the state machine by one turn: append the prompt (or drain queued
 * steer messages when the prompt is null), call the provider once with a
 * request snapshot built at turn entry, then execute the requested tools
 * sequentially. Mutates and returns the same state object.
 *
 * Throws Error("max turns exceeded") when called beyond the turn budget, and
 * propagates provider failures; an aborted state yields `stopReason:
 * "aborted"` instead of throwing.
 */
export async function stepTurn(state: AgentState, prompt: string | null): Promise<AgentState> {
  if (isAborted(state)) {
    state.stopReason = "aborted";
    return state;
  }
  if (state.turnCount >= state.maxTurns) {
    throw new Error("max turns exceeded");
  }
  if (prompt !== null) {
    assertNonEmptyText(prompt, "prompt");
    state.messages.push(createUserMessage(prompt));
  } else {
    drainSteerQueue(state);
  }

  // Per-turn snapshot: built once from the values read at turn entry.
  const request: LlmRequest = {
    systemPrompt: state.systemPrompt,
    messages: [...state.messages],
    tools: toDefinitions(state.tools),
    signal: state.signal,
  };
  state.turnCount += 1;

  const assistant = await streamAssistantMessage(state, request);
  if (assistant === null) {
    state.stopReason = "aborted";
    return state;
  }
  state.messages.push(assistant);
  if (isAborted(state) || assistant.stopReason === "aborted") {
    state.stopReason = "aborted";
    return state;
  }
  if (assistant.stopReason === "tool_use" && assistant.toolCalls.length > 0) {
    await executeToolCalls(state, request, assistant.toolCalls);
    return state;
  }
  state.stopReason = assistant.stopReason;
  return state;
}

// ---- Agent class (thin driver over the state machine) ----

/**
 * Thin wrapper over the state machine: owns the abort controller wiring and
 * the run lifecycle; every behavioral decision lives in `stepTurn`.
 */
export class Agent {
  private readonly state: AgentState;
  private readonly controller: AbortController;
  private running = false;

  constructor(options: AgentOptions) {
    this.controller = new AbortController();
    this.state = createAgentState(options);
    const external = options.signal;
    if (external === undefined) {
      return;
    }
    const onExternalAbort = (): void => {
      this.controller.abort(external.reason);
      this.state.aborted = true;
    };
    if (external.aborted) {
      onExternalAbort();
    } else {
      external.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  /** Applies to the next turn (per-turn snapshot semantics). */
  setSystemPrompt(systemPrompt: string): void {
    if (typeof systemPrompt !== "string") {
      throw new Error("systemPrompt must be a string");
    }
    this.state.systemPrompt = systemPrompt;
  }

  /** Applies to the next turn (per-turn snapshot semantics). */
  setTools(tools: Tool[]): void {
    if (!Array.isArray(tools)) {
      throw new Error("tools must be an array");
    }
    const copy = [...tools];
    assertUniqueToolNames(copy);
    this.state.tools = copy;
  }

  /** Queues a user message, drained at the start of the next continuation turn. */
  steer(text: string): void {
    assertNonEmptyText(text, "steer text");
    this.state.steerQueue.push(text);
  }

  /** Requests a cooperative stop; the running run ends with "aborted". */
  abort(): void {
    this.controller.abort();
    this.state.aborted = true;
  }

  /** Runs the loop until end_turn / aborted; throws past maxTurns or on provider errors. */
  async run(prompt: string): Promise<TurnResult> {
    if (this.running) {
      throw new Error("agent is already running");
    }
    assertNonEmptyText(prompt, "prompt");
    this.running = true;
    try {
      this.state.signal = this.controller.signal;
      this.state.turnCount = 0;
      const startCount = this.state.messages.length;
      let promptArg: string | null = prompt;
      let stop: StopReason = "end_turn";
      for (;;) {
        await stepTurn(this.state, promptArg);
        promptArg = null;
        const current = this.state.stopReason;
        if (current === null) {
          throw new Error("agent state transition completed without a stop reason");
        }
        if (current === "tool_use") {
          continue;
        }
        stop = current;
        break;
      }
      return {
        messages: [...this.state.messages],
        stopReason: stop,
        turns: this.state.turnCount,
        usage: sumUsage(this.state.messages.slice(startCount)),
      };
    } finally {
      this.running = false;
    }
  }
}
