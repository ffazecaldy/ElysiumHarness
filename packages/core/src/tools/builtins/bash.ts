import { exec } from "node:child_process";
import type { PathPolicy, Tool, ToolContext } from "../../types/tools";
import { evaluateCommand, resolveWithin } from "../policy";
import { argString, err, ok, telemetry } from "../internal";

const BASH_TIMEOUT_MS = 30_000;

function runCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = exec(
      command,
      { cwd, timeout: BASH_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let code: number | null = null;
        if (error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number") {
          code = (error as unknown as { code: number }).code;
        }
        resolve({ stdout, stderr, code });
      },
    );
    const onAbort = (): void => {
      child.kill("SIGKILL");
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function createBashTool(policy: PathPolicy): Tool {
  return {
    name: "bash",
    description:
      "Execute a shell command in the tool working directory. Subject to the command policy (denied patterns are blocked, warn patterns are flagged in telemetry).",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        cwd: { type: "string", description: "Optional working directory (must stay inside allowed roots)" },
      },
      required: ["command"],
    },
    async execute(args, ctx: ToolContext) {
      const t0 = Date.now();
      const command = argString(args, "command");
      if (command === undefined || command.trim() === "") {
        telemetry(ctx.emit, "bash", Date.now() - t0, true);
        return err("missing required argument 'command'");
      }
      const evaluation = evaluateCommand(policy, command);
      if (!evaluation.allowed) {
        telemetry(ctx.emit, "bash", Date.now() - t0, true);
        return err("blocked by policy");
      }
      let workdir = ctx.cwd;
      const cwdParam = argString(args, "cwd");
      if (cwdParam !== undefined && cwdParam.trim() !== "") {
        try {
          workdir = resolveWithin(ctx.cwd, policy, cwdParam);
        } catch (e: unknown) {
          telemetry(ctx.emit, "bash", Date.now() - t0, true);
          const message = e instanceof Error ? e.message : String(e);
          return err(message);
        }
      }
      if (evaluation.warn) {
        ctx.emit({
          type: "custom",
          timestamp: new Date().toISOString(),
          data: { warn: true, tool: "bash", command },
        });
      }
      const { stdout, stderr, code } = await runCommand(command, workdir, ctx.signal);
      const content = [stdout, stderr].filter((s) => s.length > 0).join("\n");
      const failed = code !== null && code !== 0;
      telemetry(ctx.emit, "bash", Date.now() - t0, failed);
      if (failed) {
        return err(content.length > 0 ? content : `command exited with code ${code}`);
      }
      return ok(content.length > 0 ? content : "(no output)", { exitCode: code ?? 0 });
    },
  };
}
