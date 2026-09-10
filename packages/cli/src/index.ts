/**
 * @elysium/cli — wiring: config, provider selection, command entry points.
 */
export { loadConfig } from "./config";
export type { Config, ProviderKind } from "./config";
export { runDemo, runOrchestrate, runTask } from "./commands";

export const CLI_VERSION = "0.1.0";
