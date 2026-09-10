#!/usr/bin/env node
/**
 * elysium CLI entry point.
 * Commands: demo | run <task...> | orchestrate '<json>' | --help
 */
import { runDemo, runOrchestrate, runTask } from "./commands";

const USAGE = `elysium — Elysium Harness CLI

Usage:
  elysium demo                     Run the offline scripted demo (temp file + read tool).
  elysium run <task...>            Run one task with the configured provider.
  elysium orchestrate '<json>'     Orchestrate goals: '[{"id":"a","goal":"..."}, ...]
  elysium --help                   Show this help.

Environment:
  ELYSIUM_PROVIDER      'mock' (default) | 'openai-compatible'
  ELYSIUM_BASE_URL      Base URL of the OpenAI-compatible endpoint
  ELYSIUM_API_KEY       API key for the endpoint
  ELYSIUM_MODEL         Model name (default 'gpt-4o-mini')
`;

function usageAndExit(code: number): never {
  process.stdout.write(USAGE);
  process.exitCode = code;
  throw new Error(`process exit ${code}`);
}

async function main(argv: readonly string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    process.exitCode = 0;
    return;
  }
  if (command === "demo") {
    await runDemo();
    process.exitCode = 0;
    return;
  }
  if (command === "run") {
    if (rest.length === 0) {
      process.stdout.write("error: 'run' requires a task argument\n");
      usageAndExit(1);
    }
    await runTask(rest.join(" "));
    process.exitCode = 0;
    return;
  }
  if (command === "orchestrate") {
    if (rest.length === 0) {
      process.stdout.write("error: 'orchestrate' requires a goals JSON argument\n");
      usageAndExit(1);
    }
    await runOrchestrate(rest.join(" "));
    process.exitCode = 0;
    return;
  }
  process.stdout.write(`error: unknown command '${command}'\n`);
  usageAndExit(1);
}

main(process.argv.slice(2)).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  if (message !== `process exit ${process.exitCode}`) {
    process.stdout.write(`error: ${message}\n`);
  }
  if (process.exitCode === 0) {
    process.exitCode = 1;
  }
});
