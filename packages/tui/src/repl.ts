/**
 * Terminal REPL — readline loop driving an Agent interactively.
 *
 * Streaming contract: the REPL never constructs the Agent and never subscribes
 * to an event bus. The CALLER owns the wiring — pass `handleAgentEvent` (or a
 * callback that forwards to it) into the Agent options (`onEvent`) so streamed
 * text deltas render live while `agent.run()` is in flight. The REPL prints
 * the final text again only when no delta was streamed for that run.
 */
import * as readline from "node:readline";
import type { Agent, AgentMessage } from "@elysium/core";

/** Event shape forwarded by Agent implementations to streaming consumers. */
export interface ReplEvent {
  kind: string;
  data: unknown;
}

export interface ReplOptions {
  /** The agent to drive; constructed and wired by the caller. */
  agent: Agent;
  /** Optional observer invoked for every event the REPL handles. */
  onEvent?: (e: ReplEvent) => void;
}

export interface Repl {
  /** Runs the read-eval loop until `/quit`, `/exit`, or input close. */
  start(): Promise<void>;
  /** Stops the loop and releases the readline interface. Idempotent. */
  close(): void;
  /**
   * Wire this into the Agent options (`onEvent`) so streamed text deltas
   * print live during `agent.run()`. Safe to call for any event kind.
   */
  handleAgentEvent(event: ReplEvent): void;
}

const PROMPT = "elysium> ";
const EXIT_COMMANDS = new Set(["/quit", "/exit"]);

interface TextDeltaData {
  delta: string;
}

function isTextDeltaData(data: unknown): data is TextDeltaData {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as { delta?: unknown }).delta === "string"
  );
}

/** Text of the last assistant message in the conversation, if any. */
function finalAssistantText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === "assistant") {
      return message.text;
    }
  }
  return "";
}

/**
 * Creates a readline-based REPL around a caller-constructed Agent.
 * Errors from `agent.run()` print as `error: <message>` and the loop keeps
 * running; only `/quit`, `/exit`, or a closed input stream ends it.
 */
export function createRepl(options: ReplOptions): Repl {
  const { agent } = options;
  const onEvent = options.onEvent;
  let rl: readline.Interface | null = null;
  let running = false;
  let streamedThisRun = false;

  const handleAgentEvent = (event: ReplEvent): void => {
    if (event.kind === "text_delta" && isTextDeltaData(event.data)) {
      streamedThisRun = true;
      process.stdout.write(event.data.delta);
    }
    onEvent?.(event);
  };

  const close = (): void => {
    running = false;
    if (rl !== null) {
      rl.close();
      rl = null;
    }
  };

  /** Resolves with the next input line, or null once the stream closes. */
  const ask = (): Promise<string | null> =>
    new Promise((resolve) => {
      const iface = rl;
      if (iface === null) {
        resolve(null);
        return;
      }
      const onLine = (line: string): void => {
        iface.removeListener("line", onLine);
        iface.removeListener("close", onClose);
        resolve(line);
      };
      const onClose = (): void => {
        iface.removeListener("line", onLine);
        iface.removeListener("close", onClose);
        resolve(null);
      };
      iface.once("line", onLine);
      iface.once("close", onClose);
      iface.prompt();
    });

  const runLine = async (line: string): Promise<void> => {
    streamedThisRun = false;
    try {
      const result = await agent.run(line);
      if (streamedThisRun) {
        // Deltas already rendered the answer live; close the line cleanly.
        process.stdout.write("\n");
      } else {
        const text = finalAssistantText(result.messages);
        if (text.length > 0) {
          process.stdout.write(`${text}\n`);
        }
      }
      process.stdout.write(
        `tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out\n`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      process.stdout.write(`error: ${message}\n`);
    } finally {
      streamedThisRun = false;
    }
  };

  const start = async (): Promise<void> => {
    if (running) {
      throw new Error("repl is already running");
    }
    if (rl !== null) {
      throw new Error("repl was already started; close it before starting again");
    }
    running = true;
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: PROMPT,
    });
    try {
      while (running) {
        const line = await ask();
        if (line === null) {
          process.stdout.write("\n");
          break;
        }
        const trimmed = line.trim();
        if (EXIT_COMMANDS.has(trimmed)) {
          break;
        }
        if (trimmed.length === 0) {
          continue;
        }
        await runLine(trimmed);
      }
    } finally {
      close();
    }
  };

  return { start, close, handleAgentEvent };
}
