/**
 * Typed event/telemetry bus with a bounded ring buffer.
 * Handler errors are contained: a throwing handler is reported as an
 * 'error' event (loop-guarded), never crashes the emitting path.
 */
import type { EventHandler, HarnessEvent, HarnessEventType } from "../types/events";

export interface EventBusOptions {
  bufferSize?: number;
}

export function makeEvent(
  type: HarnessEventType,
  data: Record<string, unknown>,
  ids?: { runId?: string; taskId?: string },
): HarnessEvent {
  return {
    type,
    timestamp: new Date().toISOString(),
    ...(ids?.runId !== undefined ? { runId: ids.runId } : {}),
    ...(ids?.taskId !== undefined ? { taskId: ids.taskId } : {}),
    data,
  };
}

export class EventBus {
  private readonly handlers: EventHandler[] = [];
  private readonly buffer: HarnessEvent[] = [];
  private readonly bufferSize: number;
  private inErrorHandler = false;

  constructor(options?: EventBusOptions) {
    this.bufferSize = Math.max(1, options?.bufferSize ?? 1000);
  }

  emit(event: HarnessEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.bufferSize) {
      this.buffer.shift();
    }
    for (const handler of [...this.handlers]) {
      try {
        handler(event);
      } catch (err: unknown) {
        if (this.inErrorHandler) return; // loop guard: never re-report from the error path
        this.inErrorHandler = true;
        try {
          const message = err instanceof Error ? err.message : String(err);
          this.emit({
            type: "error",
            timestamp: new Date().toISOString(),
            ...(event.runId !== undefined ? { runId: event.runId } : {}),
            ...(event.taskId !== undefined ? { taskId: event.taskId } : {}),
            data: { message, scope: "event_handler" },
          });
        } finally {
          this.inErrorHandler = false;
        }
      }
    }
  }

  on(handler: EventHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  recent(n: number): HarnessEvent[] {
    const count = Math.max(0, Math.min(n, this.buffer.length));
    return this.buffer.slice(this.buffer.length - count);
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
