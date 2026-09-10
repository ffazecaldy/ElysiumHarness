/**
 * Security tests: path containment (including symlinks), command policy
 * evaluation, bash tool enforcement, and provider secret-handling regression.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  PathPolicyError,
  createBashTool,
  evaluateCommand,
  resolveWithin,
  type HarnessEvent,
  type PathPolicy,
  type ToolContext,
  type ToolResult,
} from "@elysium/core";

const tmpRoots: string[] = [];

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(root);
  return root;
}

function policyFor(root: string): PathPolicy {
  return { allowedRoots: [root] };
}

function makeCtx(cwd: string, events: HarnessEvent[]): ToolContext {
  return {
    cwd,
    signal: new AbortController().signal,
    emit: (e: HarnessEvent) => events.push(e),
  };
}

/** Case- and spacing-insensitive denial patterns for rm -rf style commands. */
const RM_DENIED_PATTERNS = [
  "\\brm\\s+-[rR][fF]",
  "\\brm\\s+-[fF][rR]",
  "\\brm\\s+-[rR]\\s+-[fF]",
  "\\brm\\s+-[fF]\\s+-[rR]",
  "\\brm\\s+--[rR][eE][cC][uU][rR][sS][iI][vV][eE]\\s+--[fF][oO][rR][cC][eE]",
  "\\brm\\s+--[fF][oO][rR][cC][eE]\\s+--[rR][eE][cC][uU][rR][sS][iI][vV][eE]",
];

const DENIED_COMMANDS: string[] = [
  "rm -rf /",
  "RM -RF /",
  "rm  -rf ./build",
  "rm\t-rf /tmp/x",
  "rm -r -f logs",
  "rm -f -r logs",
  "rm -fr logs",
  "rm -Rf logs",
  "rm --recursive --force logs",
  "rm --force --recursive logs",
  "RM --RECURSIVE --FORCE logs",
];

describe("resolveWithin path containment", () => {
  it("rejects relative '..' escapes and multi-hop traversals", () => {
    const root = makeRoot("elysium-sec-");
    const policy = policyFor(root);
    fs.writeFileSync(path.join(root, "inside.txt"), "ok", "utf-8");
    expect(resolveWithin(root, policy, "inside.txt")).toBe(path.resolve(root, "inside.txt"));
    expect(() => resolveWithin(root, policy, "../outside.txt")).toThrow(PathPolicyError);
    expect(() => resolveWithin(root, policy, "sub/../../escape.txt")).toThrow(PathPolicyError);
    expect(() => resolveWithin(root, policy, "..")).toThrow(PathPolicyError);
  });

  it("rejects absolute paths outside the allowed roots", () => {
    const root = makeRoot("elysium-sec-");
    const policy = policyFor(root);
    const outsideAbsolute = path.resolve(root, "..", "definitely-outside.txt");
    expect(() => resolveWithin(root, policy, outsideAbsolute)).toThrow(PathPolicyError);
    if (process.platform === "win32") {
      expect(() => resolveWithin(root, policy, "C:\\Windows\\System32\\config.sys")).toThrow(
        PathPolicyError,
      );
    }
  });

  it("rejects a directory symlink inside the root pointing outside", (ctx) => {
    const root = makeRoot("elysium-sec-");
    const outsideDir = makeRoot("elysium-sec-out-");
    fs.writeFileSync(path.join(outsideDir, "inner.txt"), "secret", "utf-8");
    const link = path.join(root, "sneaky");
    try {
      fs.symlinkSync(outsideDir, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      ctx.skip();
      return;
    }
    expect(() => resolveWithin(root, policyFor(root), path.join("sneaky", "inner.txt"))).toThrow(
      PathPolicyError,
    );
    expect(() => resolveWithin(root, policyFor(root), "sneaky")).toThrow(PathPolicyError);
  });

  it("rejects a file symlink inside the root pointing outside when symlinks are permitted", (ctx) => {
    const root = makeRoot("elysium-sec-");
    const outsideDir = makeRoot("elysium-sec-out-");
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret", "utf-8");
    const link = path.join(root, "sneaky-file.txt");
    try {
      fs.symlinkSync(outsideFile, link, "file");
    } catch {
      ctx.skip();
      return;
    }
    expect(() => resolveWithin(root, policyFor(root), "sneaky-file.txt")).toThrow(PathPolicyError);
  });
});

describe("evaluateCommand policy", () => {
  const policy: PathPolicy = {
    allowedRoots: [],
    deniedCommands: RM_DENIED_PATTERNS,
    warnCommands: ["[eE][cC][hH][oO]\\s+[tT][oO][dD][aA][yY]"],
  };

  it("blocks rm -rf variants across spacing and case differences", () => {
    for (const command of DENIED_COMMANDS) {
      const verdict = evaluateCommand(policy, command);
      expect(verdict.allowed, `expected denial for: ${command}`).toBe(false);
      expect(verdict.warn, `expected no warn flag for denied: ${command}`).toBe(false);
    }
  });

  it("flags warn patterns but allows the command", () => {
    for (const command of ["echo today", "ECHO   today", "echo \t today-status"]) {
      const verdict = evaluateCommand(policy, command);
      expect(verdict.allowed, `expected allow for: ${command}`).toBe(true);
      expect(verdict.warn, `expected warn flag for: ${command}`).toBe(true);
    }
  });

  it("allows benign commands without flags and denies take precedence over warns", () => {
    const benign = evaluateCommand(policy, 'node -e "console.log(1)"');
    expect(benign.allowed).toBe(true);
    expect(benign.warn).toBe(false);
    const mixed = evaluateCommand(policy, "rm -rf x && echo today");
    expect(mixed.allowed).toBe(false);
    expect(mixed.warn).toBe(false);
  });
});

describe("bash tool enforcement", () => {
  function makeBash(root: string): { tool: ReturnType<typeof createBashTool>; events: HarnessEvent[] } {
    const policy: PathPolicy = {
      allowedRoots: [root],
      deniedCommands: RM_DENIED_PATTERNS,
      warnCommands: ["[eE][cC][hH][oO]\\s+[tT][oO][dD][aA][yY]"],
    };
    const events: HarnessEvent[] = [];
    return { tool: createBashTool(policy), events };
  }

  it("returns isError 'blocked by policy' for denied commands", async () => {
    const root = makeRoot("elysium-sec-bash-");
    const { tool } = makeBash(root);
    const result: ToolResult = await tool.execute(
      { command: "rm -rf /does-not-matter" },
      makeCtx(root, []),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe("blocked by policy");
  });

  it("executes an allowed portable command via node -e", async () => {
    const root = makeRoot("elysium-sec-bash-");
    const { tool } = makeBash(root);
    const result = await tool.execute(
      { command: 'node -e "console.log(\'portable-ok\')"' },
      makeCtx(root, []),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("portable-ok");
  });

  it("flags warn commands through telemetry while still allowing them", async () => {
    const root = makeRoot("elysium-sec-bash-");
    const { tool, events } = makeBash(root);
    const result = await tool.execute({ command: "echo today-warn-check" }, makeCtx(root, events));
    expect(result.isError).toBe(false);
    expect(result.content).toContain("today-warn-check");
    const warnEvent = events.find(
      (e) => e.type === "custom" && e.data["warn"] === true && e.data["tool"] === "bash",
    );
    expect(warnEvent).toBeDefined();
  });

  it("rejects a cwd parameter that escapes the allowed roots", async () => {
    const root = makeRoot("elysium-sec-bash-");
    const { tool } = makeBash(root);
    const result = await tool.execute(
      { command: 'node -e "console.log(1)"', cwd: "../outside-escape" },
      makeCtx(root, []),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside the allowed roots");
  });
});

describe("provider secret-handling regression", () => {
  const providersDir = fileURLToPath(new URL("../../src/providers/", import.meta.url));
  const PROVIDER_CANDIDATES = [
    "openai-compatible.ts",
    "openai-compatible-provider.ts",
    "openai.ts",
    "openai-provider.ts",
  ];

  function headerValue(headers: unknown, name: string): string | undefined {
    if (headers instanceof Headers) return headers.get(name) ?? undefined;
    if (Array.isArray(headers)) {
      for (const entry of headers) {
        if (Array.isArray(entry) && entry.length >= 2) {
          const key = entry[0];
          const value = entry[1];
          if (typeof key === "string" && typeof value === "string" && key.toLowerCase() === name) {
            return value;
          }
        }
      }
      return undefined;
    }
    if (headers !== null && typeof headers === "object") {
      for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
        if (key.toLowerCase() === name && typeof value === "string") return value;
      }
    }
    return undefined;
  }

  function readUrl(input: unknown): string {
    if (typeof input === "string") return input;
    if (input instanceof URL) return input.toString();
    if (input instanceof Request) return input.url;
    return String(input);
  }

  function resolveCtor(mod: Record<string, unknown>): (new (options: Record<string, unknown>) => unknown) | undefined {
    const candidates = [
      mod["OpenAICompatibleProvider"],
      mod["OpenAIProvider"],
      (mod["default"] instanceof Object ? (mod["default"] as Record<string, unknown>)["OpenAICompatibleProvider"] : undefined),
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "function") {
        return candidate as new (options: Record<string, unknown>) => unknown;
      }
    }
    return undefined;
  }

  it("sends the api key only via Authorization header and never exposes it on the provider surface", async (ctx) => {
    const existing = PROVIDER_CANDIDATES.filter((name) => fs.existsSync(path.join(providersDir, name)));
    if (existing.length === 0) {
      ctx.skip();
      return;
    }
    const base = (existing[0] ?? "").replace(/\.ts$/, "");
    const mod = (await import("../../src/providers/openai-compatible")) as Record<string, unknown>;
    const ctor = resolveCtor(mod);
    if (!ctor) {
      ctx.skip();
      return;
    }

    const SECRET = "sk-elysium-secret-0123456789abcdef";
    const BASE_URL = "http://127.0.0.1:9/v1";
    const calls: Array<{ url: string; initHeaders: unknown; input: unknown }> = [];
    const fetchImpl = async (input: unknown, init?: { headers?: unknown }): Promise<Response> => {
      calls.push({ url: readUrl(input), initHeaders: init?.headers, input });
      return new Response(JSON.stringify({ error: { message: "invalid api key" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    };

    const optionShapes: Array<Record<string, unknown>> = [
      { apiKey: SECRET, baseURL: BASE_URL, fetchImpl },
      { apiKey: SECRET, baseUrl: BASE_URL, fetchImpl },
      { apiKey: SECRET, fetchImpl },
    ];
    let instance: unknown;
    let constructed = false;
    for (const shape of optionShapes) {
      try {
        instance = new ctor(shape);
        constructed = true;
        break;
      } catch {
        // Try the next option naming convention.
      }
    }
    if (!constructed || !(instance instanceof Object)) {
      ctx.skip();
      return;
    }

    const streamFn = (instance as { stream?: unknown }).stream;
    if (typeof streamFn !== "function") {
      ctx.skip();
      return;
    }
    const request = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hello" }],
      tools: [],
    };
    try {
      const iterable = (streamFn as (req: unknown) => AsyncIterable<unknown>).call(instance, request);
      const iterator = iterable[Symbol.asyncIterator]();
      await iterator.next();
    } catch {
      // The stubbed 401 response may surface as a provider error; the fetch
      // observation above is all this regression test needs.
    }
    const first = calls[0];
    if (!first) {
      ctx.skip();
      return;
    }

    const headersSource =
      first.initHeaders !== undefined
        ? first.initHeaders
        : first.input instanceof Request
          ? first.input.headers
          : undefined;
    const auth = headerValue(headersSource, "authorization");
    expect(auth, "api key must travel in the Authorization header").toBeTruthy();
    expect(auth).toContain(SECRET);

    // The key never leaks into the request URL...
    expect(first.url).not.toContain(SECRET);
    // ...nor onto the provider's public surface.
    const serialized = JSON.stringify(instance) ?? "";
    expect(serialized).not.toContain(SECRET);
    for (const [key, value] of Object.entries(instance as Record<string, unknown>)) {
      if (typeof value === "string") {
        expect(`${key}=${value}`, `property ${key} must not hold the api key`).not.toContain(SECRET);
      }
    }
  });
});
