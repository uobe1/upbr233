import type { Message, ToolDefinition, ToolPropertySchema, MessageContent } from "@upbr233/ai";

// === Agent Session ===

export type AgentMode = "build" | "plan";

export interface AgentSession {
  id: string;
  mode: AgentMode;
  startedAt: number;
  contextManager: string;  // reference
}

// === Tool System ===

export type ToolApproval = "once" | "always" | "deny";

export interface ToolCallRequest {
  id: string;
  name: string;
  input: Record<string, unknown>;
  requiresApproval: boolean;
}

export interface ToolCallResult {
  id: string;
  toolName: string;
  output: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolConfig {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, ToolPropertySchema>;
    required?: string[];
  };
  requiresApproval: boolean;
  handler: (input: Record<string, unknown>) => Promise<ToolCallResult>;
}

export interface IToolRegistry {
  register(tool: ToolConfig): void;
  unregister(name: string): void;
  get(name: string): ToolConfig | undefined;
  getAll(): ToolConfig[];
  getDefinitions(): ToolDefinition[];
  execute(request: ToolCallRequest): Promise<ToolCallResult>;
  executeApproved(
    request: ToolCallRequest,
    approval: ToolApproval
  ): Promise<ToolCallResult>;
}

// === Agent Loop ===

export type AgentState = "idle" | "thinking" | "executing_tools" | "waiting_approval" | "done" | "error";

export interface AgentLoopConfig {
  maxIterations: number;
  maxTokens: number;
  mode: AgentMode;
  systemPrompt: string;
}

export interface AgentStep {
  iteration: number;
  state: AgentState;
  messages: Message[];
  toolCalls?: ToolCallRequest[];
  toolResults?: ToolCallResult[];
  error?: string;
}

// === Context Manager ===

export type ContextLayer = "system" | "rule" | "changeable";

export interface ContextManagerConfig {
  systemPrompt: string;
  persona?: string;
  rulesFiles?: string[];
  skillIndex?: SkillIndexEntry[];
  mcpTools?: ToolDefinition[];
  maxHistoryTokens: number;
  compactionThreshold: number; // e.g. 0.75 = compact at 75% of context
}

export interface SkillIndexEntry {
  name: string;
  description: string;
  magicWords: string[];
  skillPath: string; // path to SKILL.md
}

// === Timeline ===

export type TimelineActionType =
  | "withdraw"       // withdraw + revert file changes
  | "withdraw_keep"  // withdraw without reverting files
  | "copy"           // copy to clipboard
  | "delete"         // delete + create branch
  | "retry"          // retry a message/tool call
  | "continue";      // continue from any point

export interface TimelineEntry {
  id: string;
  type: "user" | "agent" | "tool_call" | "tool_result" | "subagent";
  content: string;
  metadata: Record<string, unknown>;
  timestamp: number;
  parentId: string | null;
  branchId?: string;
}

// === Subagent ===

export interface SubagentConfig {
  name: string;
  prompt: string;
  tools: string[]; // tool names this subagent can use
  parentSessionId: string;
}

export interface SubagentResult {
  subagentId: string;
  result: string;
  toolCalls: number;
  duration: number;
  error?: string;
}

// === MMP Interface (Memory Manager Pro) ===

/** Loose interface for MMP to avoid circular dependency. */
export interface IMMPManager {
  addMessage(content: string, metadata?: Record<string, unknown>): unknown;
  needsCompaction(): boolean;
  compact(summarize: (text: string) => Promise<string>): Promise<unknown>;
  buildContext(maxTokens: number): string;
}

// === Async Task ===

export interface AsyncTask {
  id: string;
  type: "subagent" | "tool";
  status: "running" | "completed" | "failed";
  startTime: number;
  endTime?: number;
  result?: ToolCallResult | SubagentResult;
  error?: string;
}
