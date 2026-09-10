/**
 * Queryable telemetry store: append-only JSONL, exact core event format.
 */
import fs from "node:fs";
import path from "node:path";
import type { HarnessEvent } from "@elysium/core";
import type { TelemetryQuery, TelemetryRecord } from "../types";

export interface TelemetryStoreOptions {
  filePath: string;
}

function within(value: string | undefined, since?: string, until?: string): boolean {
  if (since !== undefined && value !== undefined && value < since) return false;
  if (until !== undefined && value !== undefined && value > until) return false;
  if (since !== undefined && value === undefined) return false;
  if (until !== undefined && value === undefined) return false;
  return true;
}

export class TelemetryStore {
  private readonly filePath: string;
  private records: TelemetryRecord[] = [];

  constructor(options: TelemetryStoreOptions) {
    this.filePath = path.resolve(options.filePath);
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    const raw = fs.readFileSync(this.filePath, "utf-8");
    for (const line of raw.split(/\r\n|\n/)) {
      if (line.trim() === "") continue;
      this.records.push(JSON.parse(line) as TelemetryRecord);
    }
  }

  private persist(record: TelemetryRecord): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, "utf-8");
  }

  append(event: TelemetryRecord): void {
    this.records.push(event);
    this.persist(event);
  }

  query(filter?: TelemetryQuery): TelemetryRecord[] {
    const q = filter ?? {};
    return this.records.filter((r) => {
      if (q.runId !== undefined && r.runId !== q.runId) return false;
      if (q.taskId !== undefined && r.taskId !== q.taskId) return false;
      if (q.type !== undefined && r.type !== q.type) return false;
      if (!within(r.timestamp, q.since, q.until)) return false;
      return true;
    });
  }

  all(): TelemetryRecord[] {
    return [...this.records];
  }

  size(): number {
    return this.records.length;
  }
}
