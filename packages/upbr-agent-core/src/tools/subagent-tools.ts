import type { ToolConfig } from "../types";

// Subagent capability description
export const subAgentTool: ToolConfig = {
  name: "task",
  description: "Spawn a subagent to execute a task in isolation. Subagents prevent context pollution. Use for information gathering, project exploration, code review, search tasks, and executing tests.",
  inputSchema: {
    type: "object",
    properties: {
      subagentType: {
        type: "string",
        description: "Type of subagent: general (full access), explore (file exploration), plan (analysis only), review (code review)",
      },
      prompt: { type: "string", description: "Task description for the subagent" },
    },
    required: ["subagentType", "prompt"],
  },
  requiresApproval: false,
  handler: async (input) => {
    // Subagent execution is handled by the AgentLoop.spawnSubagent()
    // This tool just signals the intent; the actual spawning happens
    // through the agent loop's subagent manager

    return {
      id: "",
      toolName: "task",
      output: `Subagent task registered: ${input.subagentType}\nPrompt: ${input.prompt}\n\nThe subagent will execute this task in an isolated context and report back.`,
      isError: false,
      metadata: {
        subagentType: input.subagentType,
        needsExecution: true,
      },
    };
  },
};

export const finishTaskTool: ToolConfig = {
  name: "finish_task",
  description: "Finish the current task and report results back to the parent agent.",
  inputSchema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "Summary of what was accomplished" },
      findings: { type: "string", description: "Detailed findings and results" },
    },
    required: ["summary"],
  },
  requiresApproval: false,
  handler: async (input) => {
    return {
      id: "",
      toolName: "finish_task",
      output: `Task completed.\n\nSummary: ${input.summary}\n${input.findings ? `\nFindings:\n${input.findings}` : ""}`,
      isError: false,
      metadata: { finished: true },
    };
  },
};
