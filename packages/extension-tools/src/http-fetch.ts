/**
 * http_fetch tool: perform an HTTP/HTTPS request via global fetch with an
 * AbortController timeout. Returns the status line plus the first 5000 chars
 * of the body; network failures become isError results (never thrown).
 */
import type { Tool, ToolContext, ToolResult } from "@elysium/core";
import { argNumber, argString, err, toolTelemetry } from "./internal";

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 2147483647; // setTimeout limit
const MAX_BODY_CHARS = 5000;
const ALLOWED_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

async function runHttpFetch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const url = argString(args, "url");
  if (url === undefined || url.trim() === "") {
    return err("missing required argument 'url'");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return err(`invalid url: '${url}'`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return err(`unsupported protocol '${parsed.protocol}' — only http: and https: are allowed`);
  }
  const method = (argString(args, "method") ?? "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return err(`unsupported method '${method}'`);
  }
  const timeoutMs = argNumber(args, "timeoutMs") ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    return err("'timeoutMs' must be a positive integer number of milliseconds");
  }
  if (ctx.signal.aborted) return err("http_fetch aborted before start");
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onCallerAbort = () => controller.abort();
  ctx.signal.addEventListener("abort", onCallerAbort, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(parsed.toString(), {
        method,
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return err(`http_fetch failed: ${message}`);
    }
    let body = "";
    try {
      body = method === "HEAD" ? "" : await response.text();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return err(`could not read response body: ${message}`);
    }
    const header = `HTTP ${response.status} ${response.statusText}`.trimEnd();
    const snippet = body.slice(0, MAX_BODY_CHARS);
    const result: ToolResult = {
      content: snippet === "" ? header : `${header}\n\n${snippet}`,
      isError: response.status >= 400,
      details: { status: response.status, url: parsed.toString() },
    };
    return result;
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onCallerAbort);
  }
}

export function createHttpFetchTool(): Tool {
  return {
    name: "http_fetch",
    description:
      "Fetch an HTTP or HTTPS URL. Returns the HTTP status and the first 5000 characters of " +
      "the response body. Network errors and timeouts are reported as error results.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL to fetch" },
        method: { type: "string", description: "HTTP method (default GET)" },
        timeoutMs: { type: "number", description: "Request timeout in milliseconds (default 10000)" },
      },
      required: ["url"],
    },
    async execute(args, ctx) {
      const t0 = Date.now();
      let isError = false;
      try {
        const result = await runHttpFetch(args, ctx);
        isError = result.isError;
        return result;
      } catch (e: unknown) {
        isError = true;
        const message = e instanceof Error ? e.message : String(e);
        return err(`http_fetch failed: ${message}`);
      } finally {
        toolTelemetry(ctx.emit, "http_fetch", Date.now() - t0, isError);
      }
    },
  };
}
