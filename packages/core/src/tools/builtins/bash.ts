import { exec, spawn } from "node:child_process";
import type { PathPolicy, Tool, ToolContext, ToolResult } from "../../types/tools";
import { argString, err, ok, telemetry } from "../internal";
import { evaluateCommand, resolveWithin } from "../policy";

const BASH_TIMEOUT_MS = 30_000;

interface ProcessOutcome {
  stdout: string;
  stderr: string;
  /** Process exit code, or null when the process was killed/unspawned. */
  code: number | null;
  /** True when the process was terminated by exec timeout, signal, or abort. */
  killed: boolean;
  /** Spawn-level failure code (e.g. "ENOENT") from exec's error object. */
  spawnError?: string;
}

function runCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      onAbort();
    }, BASH_TIMEOUT_MS);
    timer.unref?.();
    const child = exec(
      command,
      { cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        let code: number | null = null;
        let killed = false;
        let spawnError: string | undefined;
        if (error) {
          const rawCode = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          if (typeof rawCode === "number") {
            code = rawCode;
          } else if (typeof rawCode === "string") {
            // exec() reports spawn failures (ENOENT, EACCES, ...) as string codes.
            spawnError = rawCode;
          }
          if (
            (error as { killed?: unknown }).killed === true ||
            (error as { signal?: unknown }).signal !== undefined
          ) {
            // exec-level timeout kill and signal terminations surface here.
            killed = true;
          }
        }
        resolve({
          stdout,
          stderr,
          code,
          killed: timedOut || killed,
          spawnError,
        });
      },
    );
    const onAbort = (): void => {
      // On Windows exec() runs `cmd /c <cmd>`; killing the cmd wrapper
      // re-parents (or races) the real child and either way the orphan holds
      // the stdio pipes open so exec's callback never fires. Empirically,
      // `taskkill /T /F` alone terminates the whole tree and lets the
      // callback fire; pairing it with child.kill() is what breaks it.
      if (process.platform === "win32") {
        try {
          spawn("taskkill", ["/T", "/F", "/PID", String(child.pid ?? -1)], {
            windowsHide: true,
            stdio: "ignore",
          });
        } catch {
          // Fall back to the wrapper kill: better a orphan than a hang.
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        } catch {
          // Not a process-group leader; the wrapper kill suffices.
        }
      }
    };
    if (signal.aborted) {
      // Child may not have spawned yet, but abort must still resolve promptly.
      onAbort();
      resolve({ stdout: "", stderr: "", code: null, killed: true });
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
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
        cwd: {
          type: "string",
          description: "Optional working directory (must stay inside allowed roots)",
        },
      },
      required: ["command"],
    },
    async execute(args, ctx: ToolContext): Promise<ToolResult> {
      const t0 = Date.now();
      try {
        // Policy evaluation lives inside error handling: a malformed
        // deniedCommands pattern or a failing resolveWithin surfaces as an
        // isError result, never an unhandled throw into the harness.
        const command = argString(args, "command");
        if (command === undefined || command.trim() === "") {
          telemetry(ctx.emit, "bash", Date.now() - t0, true);
          return err("missing required argument 'command'");
        }
        if (ctx.signal.aborted) {
          telemetry(ctx.emit, "bash", Date.now() - t0, true);
          return err("command aborted by caller");
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
        const { stdout, stderr, code, killed, spawnError } = await runCommand(
          command,
          workdir,
          ctx.signal,
        );
        const content = [stdout, stderr].filter((s) => s.length > 0).join("\n");
        if (spawnError !== undefined) {
          telemetry(ctx.emit, "bash", Date.now() - t0, true);
          return err(`command could not be spawned (${spawnError})`);
        }
        if (killed) {
          telemetry(ctx.emit, "bash", Date.now() - t0, true);
          const label = ctx.signal.aborted ? "aborted by caller" : "timed out";
          return err(content.length > 0 ? `${content}\n(command ${label})` : `command ${label}`);
        }
        const failed = code !== null && code !== 0;
        telemetry(ctx.emit, "bash", Date.now() - t0, failed);
        if (failed) {
          return err(content.length > 0 ? content : `command exited with code ${code}`);
        }
        return ok(content.length > 0 ? content : "(no output)", { exitCode: code ?? 0 });
      } catch (e: unknown) {
        // Operational failure (bad policy data, framework crash): reported as
        // an isError result, never an unhandled throw into the harness.
        telemetry(ctx.emit, "bash", Date.now() - t0, true);
        const message = e instanceof Error ? e.message : String(e);
        return err(`bash failed: ${message}`);
      }
    },
  };
}
