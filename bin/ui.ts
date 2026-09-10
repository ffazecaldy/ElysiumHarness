/**
 * bin/ui.ts — zero-dependency ANSI theme for the Elysium CLI.
 *
 * No external packages (no chalk): raw SGR escape codes only. Colors are
 * DISABLED when either:
 *   - NO_COLOR is set (https://no-color.org — any value, including empty), or
 *   - stdout is not a TTY (piped tests, CI logs) — process.stdout.isTTY false.
 * Disabled mode returns strings untouched, so assertions on piped output see
 * plain text. stripAnsi() is provided for tests/consumers that must remove
 * decorations from already-rendered strings.
 *
 * Everything here is presentation-only: no process.exit, no stdin, no
 * globals beyond the spinner instance you create.
 */

/** A function that wraps text in a color (or returns it untouched). */
export type Colorize = (s: string) => string;

const COLORS_ENABLED =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  process.stdout.isTTY === true;

function colorize(open: string, reset: string): Colorize {
  return (s: string): string =>
    COLORS_ENABLED ? `\u001B[${open}m${s}\u001B[${reset}m` : s;
}

export const dim = colorize("2", "22");
export const bold = colorize("1", "22");
export const cyan = colorize("36", "39");
export const green = colorize("32", "39");
export const yellow = colorize("33", "39");
export const red = colorize("31", "39");
export const magenta = colorize("35", "39");

/** Unicode glyph vocabulary (plain chars — safe when colors are off). */
export const icons = {
  ok: "✓",
  err: "✗",
  warn: "⚠",
  info: "→",
  spark: "⚡",
  gear: "⚙",
} as const;

const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/g;

/** Remove all ANSI SGR sequences from a rendered string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_PATTERN, "");
}

/** Approximate visible width (code points, ANSI stripped) for box math. */
function visualWidth(s: string): number {
  return Array.from(stripAnsi(s)).length;
}

/** Horizontal rule, indented to the CLI gutter. */
export function hr(width = 56): string {
  return `  ${dim("─".repeat(width))}`;
}

/** Aligned "label    value" status line with the CLI gutter. */
export function kv(label: string, value: string): string {
  const pad = Math.max(1, 11 - label.length);
  return `  ${cyan(label)}${" ".repeat(pad)} ${value}`;
}

/**
 * Rounded box renderer for the banner. Handles ANSI-bearing content:
 * widths are computed on stripped text.
 */
export function box(title: string, subtitle = ""): string {
  const lines = subtitle.length > 0 ? [title, subtitle] : [title];
  const inner = Math.max(...lines.map((l) => visualWidth(l))) + 4;
  const top = `  ${dim(`╭${"─".repeat(inner)}╮`)}`;
  const bottom = `  ${dim(`╰${"─".repeat(inner)}╯`)}`;
  const body = lines.map((l) => {
    const pad = Math.max(0, inner - 2 - visualWidth(l));
    return `  ${dim("│")}  ${l}${" ".repeat(pad)}${dim("│")}`;
  });
  return [top, ...body, bottom].join("\n");
}

// ── Spinner ───────────────────────────────────────────────────────

const DEFAULT_FRAMES: readonly string[] = [
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
];

export interface Spinner {
  /** Begin animating `text`. No-op when output is not an animated TTY. */
  start(text: string): void;
  /** Stop animating; clear the frame line, then optionally print an outcome. */
  stop(okText?: string, errText?: string): void;
}

/**
 * Braille spinner on process.stdout.write + setInterval (the interval is
 * always cleared on stop, and unref'd so it never holds the process open).
 * Non-TTY: start() prints nothing and stop() only prints an outcome, so
 * piped/test output stays deterministic.
 */
export function spinner(frames: readonly string[] = DEFAULT_FRAMES): Spinner {
  const animated = COLORS_ENABLED;
  let timer: NodeJS.Timeout | null = null;
  let index = 0;
  let current = "";

  const clearLine = (): void => {
    if (animated) process.stdout.write("\r\u001B[K");
  };
  const render = (): void => {
    process.stdout.write(`\r\u001B[K  ${cyan(frames[index] ?? "")} ${dim(current)}`);
  };

  return {
    start(text: string): void {
      current = text;
      if (!animated || timer !== null) return;
      render();
      timer = setInterval(() => {
        index = (index + 1) % frames.length;
        render();
      }, 80);
      timer.unref();
    },
    stop(okText?: string, errText?: string): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
      if (animated) clearLine();
      if (okText !== undefined) console.log(`  ${green(icons.ok)} ${okText}`);
      else if (errText !== undefined) console.log(`  ${red(icons.err)} ${errText}`);
    },
  };
}

// ── Provider error translation ────────────────────────────────────

export interface TranslatedError {
  /** Short human headline (rendered big). */
  title: string;
  /** Actionable next step; rendered as `title - hint`. */
  hint: string;
  /** Raw provider detail, single-line, truncated to 120 chars (rendered dim). */
  detail: string;
}

/** Flatten an error plus its `cause` chain (max depth 5) into one string. */
function errorChainText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur !== undefined && cur !== null; depth += 1) {
    if (cur instanceof Error) {
      parts.push(cur.message);
      const code = (cur as NodeJS.ErrnoException).code;
      if (typeof code === "string") parts.push(code);
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(" | ");
}

/**
 * Map a provider/fetch failure to a human message BEFORE printing.
 * Detection runs on the full message+cause chain so wrapped provider
 * errors (`openai-compatible HTTP 429: {"error":{"code":1113,...}}`,
 * undici "fetch failed", errno codes) all translate correctly.
 */
export function translateProviderError(err: unknown): TranslatedError {
  const chain = errorChainText(err);
  const first = err instanceof Error ? err.message : String(err);
  const detail = first.replace(/\s+/g, " ").trim().slice(0, 120);
  const hay = chain.toLowerCase();

  const is429 = /\b429\b/.test(hay);
  const outOfCredits = /\b1113\b/.test(hay) || /balance|insufficient|余额|不足/.test(chain);
  if (is429 && outOfCredits) {
    return { title: "Provider account out of credits", hint: "recharge or /model <another>", detail };
  }
  if (is429) {
    return { title: "Rate limited", hint: "wait or switch provider", detail };
  }
  if (/\b(?:401|403)\b/.test(hay)) {
    return { title: "Invalid or unauthorized API key", hint: "check /key <provider> <key>", detail };
  }
  if (/\b404\b/.test(hay)) {
    return { title: "Model not found", hint: "/model <provider> <model>", detail };
  }
  if (/(fetch failed|enotfound|econnrefused|econnreset|eai_again|etimedout|request failed|network)/.test(hay)) {
    return { title: "Cannot reach the provider host", hint: "check connection", detail };
  }
  return { title: "Provider error", hint: "check /connections and retry", detail };
}
