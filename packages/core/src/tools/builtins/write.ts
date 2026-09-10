import fs from "node:fs";
import path from "node:path";
import type { PathPolicy, Tool } from "../../types/tools";
import { resolveWithin } from "../policy";
import { argBoolean, argString, err, ok, telemetry } from "../internal";

export function createWriteTool(policy: PathPolicy): Tool {
  return {
    name: "write",
    description:
      "Write a UTF-8 text file (overwrite). Fails if the parent directory is missing unless createDirs is true.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute or relative to cwd)" },
        content: { type: "string", description: "Full file content" },
        createDirs: { type: "boolean", description: "Create missing parent directories (default false)" },
      },
      required: ["path", "content"],
    },
    async execute(args, ctx) {
      const t0 = Date.now();
      const p = argString(args, "path");
      const content = argString(args, "content");
      if (p === undefined || p.trim() === "" || content === undefined) {
        telemetry(ctx.emit, "write", Date.now() - t0, true);
        return err("missing required arguments 'path' and 'content'");
      }
      try {
        const abs = resolveWithin(ctx.cwd, policy, p);
        const parent = path.dirname(abs);
        if (!fs.existsSync(parent)) {
          if (argBoolean(args, "createDirs") === true) {
            fs.mkdirSync(parent, { recursive: true });
          } else {
            telemetry(ctx.emit, "write", Date.now() - t0, true);
            return err(`parent directory does not exist: ${parent} (pass createDirs=true to create)`);
          }
        }
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
          telemetry(ctx.emit, "write", Date.now() - t0, true);
          return err(`path is a directory: ${p}`);
        }
        fs.writeFileSync(abs, content, "utf-8");
        telemetry(ctx.emit, "write", Date.now() - t0, false);
        return ok(`wrote ${content.length} chars to ${p}`, { path: abs, bytes: Buffer.byteLength(content) });
      } catch (e: unknown) {
        telemetry(ctx.emit, "write", Date.now() - t0, true);
        const message = e instanceof Error ? e.message : String(e);
        return err(message);
      }
    },
  };
}
