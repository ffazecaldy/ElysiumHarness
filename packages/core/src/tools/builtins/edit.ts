import fs from "node:fs";
import type { PathPolicy, Tool } from "../../types/tools";
import { resolveWithin } from "../policy";
import { argBoolean, argString, err, ok, telemetry } from "../internal";

/** Adapt a needle/replacement to the file's dominant EOL style. */
function matchEol(text: string, s: string): string {
  if (text.includes("\r\n") && !s.includes("\r\n")) {
    return s.replace(/\n/g, "\r\n");
  }
  return s;
}

export function createEditTool(policy: PathPolicy): Tool {
  return {
    name: "edit",
    description:
      "Replace an exact substring in a text file. Requires a unique match unless replaceAll is true. Preserves the file's line-ending style.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute or relative to cwd)" },
        oldText: { type: "string", description: "Exact text to find" },
        newText: { type: "string", description: "Replacement text" },
        replaceAll: { type: "boolean", description: "Replace every occurrence (default false)" },
      },
      required: ["path", "oldText", "newText"],
    },
    async execute(args, ctx) {
      const t0 = Date.now();
      const p = argString(args, "path");
      const oldText = argString(args, "oldText");
      const newText = argString(args, "newText");
      if (p === undefined || oldText === undefined || newText === undefined) {
        telemetry(ctx.emit, "edit", Date.now() - t0, true);
        return err("missing required arguments 'path', 'oldText', 'newText'");
      }
      if (oldText === "") {
        telemetry(ctx.emit, "edit", Date.now() - t0, true);
        return err("'oldText' must not be empty");
      }
      try {
        const abs = resolveWithin(ctx.cwd, policy, p);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          telemetry(ctx.emit, "edit", Date.now() - t0, true);
          return err(`file does not exist: ${p}`);
        }
        const original = fs.readFileSync(abs, "utf-8");
        const needle = matchEol(original, oldText);
        const replacement = matchEol(original, newText);
        const first = original.indexOf(needle);
        if (first < 0) {
          telemetry(ctx.emit, "edit", Date.now() - t0, true);
          return err("oldText not found in file");
        }
        const replaceAll = argBoolean(args, "replaceAll") === true;
        let updated: string;
        let count: number;
        if (replaceAll) {
          count = original.split(needle).length - 1;
          updated = original.split(needle).join(replacement);
        } else {
          const second = original.indexOf(needle, first + needle.length);
          if (second >= 0) {
            telemetry(ctx.emit, "edit", Date.now() - t0, true);
            return err("oldText matches multiple locations; pass replaceAll=true or add context");
          }
          count = 1;
          updated = original.slice(0, first) + replacement + original.slice(first + needle.length);
        }
        fs.writeFileSync(abs, updated, "utf-8");
        telemetry(ctx.emit, "edit", Date.now() - t0, false);
        return ok(`replaced ${count} occurrence(s) in ${p}`, { path: abs, replacements: count });
      } catch (e: unknown) {
        telemetry(ctx.emit, "edit", Date.now() - t0, true);
        const message = e instanceof Error ? e.message : String(e);
        return err(message);
      }
    },
  };
}
