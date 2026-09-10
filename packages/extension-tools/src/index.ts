/**
 * @elysium/extension-tools — extra tools beyond the core four.
 * Register them on a core ToolRegistry; the core never depends on this package.
 */
export { createGrepTool } from "./grep";
export { createGlobTool } from "./glob";
export { createHttpFetchTool } from "./http-fetch";

export const EXTENSION_TOOLS_VERSION = "0.1.0";
