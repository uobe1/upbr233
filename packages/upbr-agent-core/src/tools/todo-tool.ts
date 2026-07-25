import type { ToolConfig } from "../types";

// In-memory todo list for the current session
interface TodoItem {
  id: string;
  task: string;
  completed: boolean;
  createdAt: number;
}

const todoList: TodoItem[] = [];

export const writeTodosTool: ToolConfig = {
  name: "write_todos",
  description: "Create and manage a todo list for tracking implementation steps. Use this to plan your work and track progress. Call with the complete list of todos and their status each time.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "Complete list of todos with their completion status",
        items: {
          type: "object",
          properties: {
            task: { type: "string", description: "Description of the task" },
            completed: { type: "boolean", description: "Whether the task is completed" },
          },
          required: ["task", "completed"],
        },
      },
    },
    required: ["todos"],
  },
  requiresApproval: false,
  handler: async (input) => {
    const todos = input.todos as Array<{ task: string; completed: boolean }>;

    // Clear and rebuild the todo list
    todoList.length = 0;

    for (const item of todos) {
      todoList.push({
        id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        task: item.task,
        completed: item.completed,
        createdAt: Date.now(),
      });
    }

    const completed = todoList.filter((t) => t.completed).length;
    const total = todoList.length;

    const formatted = todoList
      .map((t) => `${t.completed ? "[✓]" : "[ ]"} ${t.task}`)
      .join("\n");

    return {
      id: "",
      toolName: "write_todos",
      output: `Todo list updated (${completed}/${total} completed):\n\n${formatted}`,
      isError: false,
      metadata: { completed, total },
    };
  },
};

export const readTodosTool: ToolConfig = {
  name: "read_todos",
  description: "Read the current todo list to check progress.",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  requiresApproval: false,
  handler: async () => {
    if (todoList.length === 0) {
      return {
        id: "",
        toolName: "read_todos",
        output: "No todos currently tracked.",
        isError: false,
      };
    }

    const completed = todoList.filter((t) => t.completed).length;
    const total = todoList.length;

    const formatted = todoList
      .map((t) => `${t.completed ? "[✓]" : "[ ]"} ${t.task}`)
      .join("\n");

    return {
      id: "",
      toolName: "read_todos",
      output: `Todo list (${completed}/${total}):\n\n${formatted}`,
      isError: false,
      metadata: { completed, total },
    };
  },
};
