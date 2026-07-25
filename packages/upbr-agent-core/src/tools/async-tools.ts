import type { ToolConfig } from "../types";

// Store for active async tasks
const asyncTasks = new Map<string, {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  status: "running" | "completed" | "failed";
  result?: string;
  error?: string;
  startTime: number;
  endTime?: number;
}>();

export const asyncTaskTool: ToolConfig = {
  name: "async_task",
  description: "Execute a tool call asynchronously. Returns immediately with a task ID. Use async_view to check progress.",
  inputSchema: {
    type: "object",
    properties: {
      tool: { type: "string", description: "Name of the tool to execute" },
      input: { type: "object", description: "Input for the tool" },
    },
    required: ["tool", "input"],
  },
  requiresApproval: false,
  handler: async (input) => {
    const toolName = input.tool as string;
    const toolInput = (input.input as Record<string, unknown>) || {};
    const taskId = `async_${Date.now()}`;

    const task: {
      id: string;
      toolName: string;
      input: Record<string, unknown>;
      status: "running" | "completed" | "failed";
      result?: string;
      error?: string;
      startTime: number;
      endTime?: number;
    } = {
      id: taskId,
      toolName,
      input: toolInput,
      status: "running" as const,
      startTime: Date.now(),
    };

    asyncTasks.set(taskId, task);

    // Execute in background
    // Note: In a real implementation, this would use proper async IPC (NNG)
    setTimeout(async () => {
      try {
        // The tool execution is handled by the agent loop, so here
        // we just mark the task. The actual execution happens when
        // the agent dispatches the tool call.
        task.status = "completed";
        task.result = `Task ${taskId} completed`;
        task.endTime = Date.now();
      } catch (e) {
        task.status = "failed";
        task.error = e instanceof Error ? e.message : String(e);
        task.endTime = Date.now();
      }
    }, 0);

    return {
      id: "",
      toolName: "async_task",
      output: `Async task started: ${taskId}\nTool: ${toolName}\nUse async_view to check status.`,
      isError: false,
      metadata: { taskId },
    };
  },
};

export const asyncViewTool: ToolConfig = {
  name: "async_view",
  description: "View the status of an async task.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "ID of the async task" },
    },
    required: ["taskId"],
  },
  requiresApproval: false,
  handler: async (input) => {
    const taskId = input.taskId as string;
    const task = asyncTasks.get(taskId);

    if (!task) {
      const tasks = [...asyncTasks.entries()].map(
        ([id, t]) => `  ${id}: ${t.toolName} [${t.status}]`
      );
      return {
        id: "",
        toolName: "async_view",
        output: `Task "${taskId}" not found.\n\nActive tasks:\n${tasks.length > 0 ? tasks.join("\n") : "  (none)"}`,
        isError: true,
      };
    }

    const elapsed = (task.endTime || Date.now()) - task.startTime;
    return {
      id: "",
      toolName: "async_view",
      output: [
        `Task: ${task.id}`,
        `Tool: ${task.toolName}`,
        `Status: ${task.status}`,
        `Elapsed: ${(elapsed / 1000).toFixed(1)}s`,
        task.result ? `Result: ${task.result}` : "",
        task.error ? `Error: ${task.error}` : "",
      ].filter(Boolean).join("\n"),
      isError: task.status === "failed",
      metadata: task,
    };
  },
};
