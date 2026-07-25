export * from "./types";

export { AgentLoop } from "./agent-loop";
export type { AgentLoopHooks, ToolApprovalCallback } from "./agent-loop";

export { ContextManager } from "./context-manager";
export { ToolRegistry } from "./tool-system";
export { SubagentManager } from "./subagent";
export { PluginManager } from "./plugin-system";
export type { Plugin, PluginManifest, PluginHooks, PluginContext } from "./plugin-system";
export { SessionStore } from "./session-store";
export { FileSnapshotManager } from "./file-snapshot";

// IPC system (NNG-style)
export { IpcHub } from "./ipc/ipc-hub";
export { setSubConnectIpcHub, getSubConnectIpcHub } from "./tools/sub-connect-tool";
export type { IpcEnvelope, IpcPeerId, IpcSocketType } from "./ipc/types";

// MCP (Model Context Protocol)
export { McpClient } from "./mcp/mcp-client";
export type { McpTool, McpServerInfo } from "./mcp/mcp-client";

// Built-in tools
export {
  readFileTool, writeFileTool, editFileTool, globFileTool,
  searchFileTool, listDirTool, treeDirTool, makeDirTool,
} from "./tools/file-tools";
export { runCmdTool } from "./tools/shell-tool";
export { webFetchTool, webSearchTool } from "./tools/web-tools";
export { loadSkillTool } from "./tools/skill-tool";
export { asyncTaskTool, asyncViewTool } from "./tools/async-tools";
export { subAgentTool, finishTaskTool } from "./tools/subagent-tools";

import { ToolRegistry } from "./tool-system";

export { askUserTool } from "./tools/ask-user-tool";
export { writeTodosTool, readTodosTool } from "./tools/todo-tool";
import {
  readFileTool, writeFileTool, editFileTool, globFileTool,
  searchFileTool, listDirTool, treeDirTool, makeDirTool,
} from "./tools/file-tools";
import { runCmdTool } from "./tools/shell-tool";
import { webFetchTool, webSearchTool } from "./tools/web-tools";
import { loadSkillTool } from "./tools/skill-tool";
import { askUserTool } from "./tools/ask-user-tool";
import { writeTodosTool, readTodosTool } from "./tools/todo-tool";
import { asyncTaskTool, asyncViewTool } from "./tools/async-tools";
import { subAgentTool, finishTaskTool } from "./tools/subagent-tools";
import { subConnectTool } from "./tools/sub-connect-tool";
import { mcpConnectTool, mcpListToolsTool, mcpCallToolTool } from "./tools/mcp-tool";

/**
 * Create a ToolRegistry pre-loaded with all built-in tools.
 */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  // File tools
  registry.register(readFileTool);
  registry.register(writeFileTool);
  registry.register(editFileTool);
  registry.register(globFileTool);
  registry.register(searchFileTool);
  registry.register(listDirTool);
  registry.register(treeDirTool);
  registry.register(makeDirTool);

  // Shell
  registry.register(runCmdTool);

  // Web
  registry.register(webFetchTool);
  registry.register(webSearchTool);

  // Skill
  registry.register(loadSkillTool);
  registry.register(askUserTool);
  registry.register(writeTodosTool);
  registry.register(readTodosTool);

  // Async
  registry.register(asyncTaskTool);
  registry.register(asyncViewTool);

  // Subagent
  registry.register(subAgentTool);
  registry.register(finishTaskTool);
  registry.register(subConnectTool);

  // MCP
  registry.register(mcpConnectTool);
  registry.register(mcpListToolsTool);
  registry.register(mcpCallToolTool);

  return registry;
}
