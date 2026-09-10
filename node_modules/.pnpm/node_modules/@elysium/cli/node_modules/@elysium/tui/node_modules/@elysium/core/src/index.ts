/**
 * @elysium/core — public API surface.
 * Minimal core: agent loop, tool system, session & state, orchestration
 * primitives (depth <= 2), streaming quality gate, multi-provider LLM
 * interface, event/telemetry bus.
 */

// ---- FROZEN SHARED TYPES ----
export * from "./types/content";
export * from "./types/messages";
export * from "./types/provider";
export * from "./types/events";
export * from "./types/tools";
export * from "./types/session";
export * from "./types/quality";
export * from "./types/orchestration";

// ---- IMPLEMENTATION MODULES (populated by build phases) ----
// Exported as they land; kept alphabetical to reduce merge conflicts.
// export * from "./agent/agent";
// export * from "./events/bus";
// export * from "./orchestration/orchestrator";
// export * from "./providers/mock-provider";
// export * from "./providers/registry";
// export * from "./quality/gate";
// export * from "./session/session";
// export * from "./tools/registry";
