# BUILD CONTRACT — READ FIRST (all subagents)

You are building **Elysium Harness**, a TypeScript pnpm monorepo agent harness.
Repo root: `C:\Users\Admin\OneDrive - Florian Elmazi\Documenti\ProgettiAtigravity\ElysiumHarness`

## Verify command (run after your work)
```
cd "C:\Users\Admin\OneDrive - Florian Elmazi\Documenti\ProgettiAtigravity\ElysiumHarness" && pnpm --filter <your-package> build && pnpm test
```
(`pnpm test` runs vitest; it fails with "No test files found" only if NO test exists repo-wide — your own test files satisfy it.)

## Absolute rules
1. **English only** — code, comments, docstrings, file names.
2. **TypeScript strict.** No `any` (biome `noExplicitAny: error`). No `TODO`/`FIXME`/`NotImplementedError`/stubs — full implementations only.
3. **DO NOT modify** anything outside your owned paths (listed in your task). Shared types in `packages/core/src/types/` are FROZEN — import them, never edit them.
4. **DO NOT** run `git` commands, `pnpm install`, or `pnpm build` at repo root. Only build your own package: `pnpm --filter <pkg> build`.
5. **DO NOT** start servers or long-running processes.
6. Do not create new npm dependencies (stdlib + existing devDeps only). Node ≥ 22, ES2022, ESM (`import`/`export`).
7. `noUncheckedIndexedAccess` is ON — array access returns `T | undefined`; handle it.
8. If a type you need is missing in `core/src/types/`, define it **locally in your own files** and note it in your report. Never edit frozen files.
9. Errors: explicit error handling; throw `Error` subclasses with clear messages; never swallow.
10. Return the mandatory report format (Summary/Artifacts/Decisions/Risks/Self-Score/Next Actions) at the end.

## Frozen API cheat-sheet (import from `@elysium/core`)
All in `packages/core/src/types/*.ts`, re-exported by `packages/core/src/index.ts`:

- `AgentMessage = UserMessage | AssistantMessage | ToolResultMessage`
  - `UserMessage { role: "user"; content: string }`
  - `AssistantMessage { role: "assistant"; text: string; toolCalls: ToolCallPart[]; stopReason: StopReason; usage?: TokenUsage }`
  - `ToolResultMessage { role: "tool_result"; toolCallId: string; toolName: string; content: string; isError: boolean; details?: unknown }`
  - `TokenUsage { inputTokens: number; outputTokens: number }`, `StopReason = "end_turn" | "tool_use" | "aborted" | "error"`
- `ToolCallPart { type: "tool_call"; id: string; name: string; arguments: Record<string, unknown> }`
- `LlmProvider { id: string; stream(req: LlmRequest): AsyncIterable<StreamEvent> }`;
  `LlmRequest { systemPrompt; messages: AgentMessage[]; tools: ToolDefinition[]; signal?: AbortSignal }`
  - `StreamEvent = { type:"text_delta"; delta } | { type:"tool_call_start"; id; name } | { type:"tool_call_delta"; id; argumentsDelta } | { type:"done"; message: AssistantMessage } | { type:"error"; error }`
  - `ScriptedTurn { text?: string; toolCalls?: { name; arguments }[]; usage? }` — script format for `MockProvider` (implement it in `core/src/providers/mock-provider.ts`)
- `Tool<P> { name; description; parameters: JsonSchema; execute(args, ctx): Promise<ToolResult> }`
  - `ToolContext { cwd: string; signal: AbortSignal; emit(event: HarnessEvent): void }`
  - `ToolResult { content: string; isError: boolean; details?: unknown }`
  - `PathPolicy { allowedRoots: string[]; deniedCommands?: string[]; warnCommands?: string[] }`
- `SessionEntry { id; parentId: string | null; timestamp: string; data: SessionEntryData }`
  - `SessionEntryData = { kind:"user"|"assistant"|"tool_result"; message } | { kind:"summary"; text; coversEntryIds } | { kind:"meta"; label; data? }`
  - `CompactionOptions { summarizer?; keepMessages? }`, `CompactionResult { summaryEntryId; coveredCount }`, `Checkpoint { entryId: string | null; entryCount: number }`
- `HarnessEvent { type: HarnessEventType; timestamp: string; runId?; taskId?; data: Record<string, unknown> }`
  - `HarnessEventType = "task_started" | "task_ended" | "turn_started" | "turn_ended" | "tool_called" | "token_usage" | "latency" | "quality_evaluated" | "error" | "custom"`
- `Rubric { id; dimensions: { name; weight; instruction }[]; threshold }`,
  `GateArtifact { taskId?; kind: "code"|"text"|"plan"; content: string; criteria?: string[] }`,
  `QualityScore { dimensions: {name;weight;score;reason}[]; weighted; passed; reasons: string[] }`, `JudgeFn`
- `SubagentTask { id; goal; context?; acceptanceCriteria? }`,
  `SubagentResult { taskId; status: "pass"|"fail"|"partial"; summary; artifacts: string[]; score? }`,
  `OrchestrationPlan { goal; maxDepth: 2; subtasks; critic? }`, `SpawnFn`, `OrchestrationReport`, `CriticVerdict`, `SubtaskReport`

## File you may reference
`docs/architecture.md` — normative behavior contract for every module.

## Code style
Double quotes, semicolons, 2-space indent, 100 col. Match existing files.
