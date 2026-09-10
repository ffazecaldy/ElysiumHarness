/**
 * Offline demo — a complete agent run with zero network:
 * MockProvider (scripted turns) -> Agent (v-a) -> ToolRegistry (builtin read)
 * -> final answer. Proves the harness loop end-to-end.
 *
 * Run with: pnpm demo
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Agent,
  MockProvider,
  type ToolCallPart,
  ToolRegistry,
  type ToolResultMessage,
  createBuiltinTools,
} from "@elysium/core";

async function main(): Promise<void> {
  // 1. Seed a workspace with a file the agent will read.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "elysium-demo-"));
  const notePath = path.join(workspace, "note.txt");
  fs.writeFileSync(notePath, "Elysium Harness is alive.", "utf-8");

  // 2. Scripted model behavior: ask for the file, then answer from its content.
  const provider = new MockProvider([
    {
      toolCalls: [{ name: "read", arguments: { path: "note.txt" } }],
      text: "I will read the note.",
    },
    {
      text: "The note says: Elysium Harness is alive.",
    },
  ]);

  // 3. Tool system: policy confines the agent to the demo workspace.
  const policy = { allowedRoots: [workspace] };
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools(policy)) registry.register(tool);

  const agent = new Agent({
    systemPrompt: "You are a demo agent. Use tools to answer.",
    provider,
    maxTurns: 4,
    executeTool: async (call: ToolCallPart): Promise<ToolResultMessage> => {
      const tool = registry.get(call.name);
      if (!tool) {
        return {
          role: "tool_result",
          toolCallId: call.id,
          toolName: call.name,
          content: `unknown tool: ${call.name}`,
          isError: true,
        };
      }
      const result = await tool.execute(call.arguments, {
        cwd: workspace,
        signal: new AbortController().signal,
        emit: () => undefined,
      });
      return {
        role: "tool_result",
        toolCallId: call.id,
        toolName: call.name,
        content: result.content,
        isError: result.isError,
        details: result.details,
      };
    },
  });

  // 4. Run.
  const result = await agent.run("What does the note say?");
  console.log("=== elysium demo ===");
  for (const message of result.messages) {
    if (message.role === "user") console.log(`[user]      ${message.content}`);
    else if (message.role === "assistant") {
      console.log(`[assistant] ${message.text}`);
      for (const call of message.toolCalls) {
        console.log(`[tool_call] ${call.name}(${JSON.stringify(call.arguments)})`);
      }
    } else {
      console.log(`[tool]      -> ${message.content}`);
    }
  }
  console.log(
    `--- stop=${result.stopReason} turns=${result.turns} tokens=${result.usage.inputTokens}in/${result.usage.outputTokens}out`,
  );
  fs.rmSync(workspace, { recursive: true, force: true });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
