import fs from "node:fs";
import type { PathPolicy, Tool } from "../../types/tools";
import { argNumber, argString, err, ok, telemetry } from "../internal";
import { resolveWithin } from "../policy";

interface ReadWindow {
  content: string;
  totalLines: number;
}

function readWindow(abs: string, offset?: number, length?: number): ReadWindow {
  const raw = fs.readFileSync(abs, "utf-8");
  const lines = raw.split(/\r\n|\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const totalLines = lines.length;
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = length === undefined ? totalLines : Math.min(totalLines, start + length);
  const window = lines.slice(start, end).join("\n");
  return { content: window, totalLines };
}

export function createReadTool(policy: PathPolicy): Tool {
  return {
    name: "read",
    description:
      "Read a UTF-8 text file. Optional 1-based line offset and max line count window the read.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute or relative to cwd)" },
        offset: { type: "number", description: "1-based start line (default 1)" },
        length: { type: "number", description: "Max lines to read (default all)" },
      },
      required: ["path"],
    },
    async execute(args, ctx) {
      const t0 = Date.now();
      const p = argString(args, "path");
      if (p === undefined || p.trim() === "") {
        telemetry(ctx.emit, "read", Date.now() - t0, true);
        return err("missing required argument 'path'");
      }
      try {
        const abs = resolveWithin(ctx.cwd, policy, p);
        const offset = argNumber(args, "offset");
        const length = argNumber(args, "length");
        if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
          telemetry(ctx.emit, "read", Date.now() - t0, true);
          return err("'offset' must be a positive integer (1-based line)");
        }
        if (length !== undefined && (!Number.isInteger(length) || length < 1)) {
          telemetry(ctx.emit, "read", Date.now() - t0, true);
          return err("'length' must be a positive integer");
        }
        const win = readWindow(abs, offset, length);
        if (win.totalLines === 0) {
          telemetry(ctx.emit, "read", Date.now() - t0, true);
          return err(`file is empty: ${p}`);
        }
        telemetry(ctx.emit, "read", Date.now() - t0, false);
        return ok(win.content, { path: abs, totalLines: win.totalLines });
      } catch (e: unknown) {
        telemetry(ctx.emit, "read", Date.now() - t0, true);
        const message = e instanceof Error ? e.message : String(e);
        return err(message);
      }
    },
  };
}
