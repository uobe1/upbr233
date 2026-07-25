import type {
  IProvider,
  LLMRequest,
  LLMResponse,
  StreamEvent,
  Message,
  ToolUseContent,
  MessageContent,
} from "@upbr233/ai";
import type {
  AgentLoopConfig,
  AgentState,
  AgentStep,
  ToolCallRequest,
  ToolCallResult,
  SubagentConfig,
  SubagentResult,
} from "./types";
import type { ToolRegistry } from "./tool-system";
import type { ContextManager } from "./context-manager";
import { SubagentManager } from "./subagent";
import type { IMMPManager } from "./types";
import type { SessionStore } from "./session-store";

export type ToolApprovalCallback = (
  request: ToolCallRequest
) => Promise<"once" | "always" | "deny">;

export interface AgentLoopHooks {
  onThinking?: () => void;
  onTextDelta?: (text: string) => void;
  onToolCall?: (request: ToolCallRequest) => void | Promise<void>;
  onToolResult?: (result: ToolCallResult) => void | Promise<void>;
  onError?: (error: string) => void;
  onStateChange?: (state: AgentState) => void;
  onNeedApproval?: (request: ToolCallRequest) => Promise<"once" | "always" | "deny">;
}

/**
 * Agent Loop - the core orchestrator.
 *
 * Flow:
 *   1. Build context from ContextManager
 *   2. Send to LLM provider
 *   3. Parse response for tool calls
 *   4. Execute tools (with approval if needed)
 *   5. Feed results back -> repeat until no more tool calls
 */
export class AgentLoop {
  private provider: IProvider;
  private tools: ToolRegistry;
  private contextManager: ContextManager;
  private config: AgentLoopConfig;
  private subagents: SubagentManager;
  private hooks: AgentLoopHooks = {};
  private mmp: IMMPManager | null = null;
  private sessionStore: SessionStore | null = null;
  private sessionId: string | null = null;
  private entryOrder = 0;

  private state: AgentState = "idle";
  private iteration = 0;
  private messages: Message[] = [];
  private currentModel: string;

  constructor(
    provider: IProvider,
    tools: ToolRegistry,
    contextManager: ContextManager,
    config: AgentLoopConfig,
    model: string
  ) {
    this.provider = provider;
    this.tools = tools;
    this.contextManager = contextManager;
    this.config = config;
    this.currentModel = model;
    this.subagents = new SubagentManager(provider, tools, model);

    // Initialize with system prompt
    this.messages.push({
      role: "system",
      content: config.systemPrompt,
    });
  }

  setHooks(hooks: AgentLoopHooks): void {
    this.hooks = hooks;
  }

  setModel(model: string): void {
    this.currentModel = model;
    this.subagents.setModel(model);
  }

  /** Integrate Memory Manager Pro for DAG-based context compaction. */
  setMmp(mmp: IMMPManager): void {
    this.mmp = mmp;
  }

  getMmp(): IMMPManager | null {
    return this.mmp;
  }

  /** Integrate SessionStore for timeline persistence. */
  setSessionStore(store: SessionStore, sessionId: string): void {
    this.sessionStore = store;
    this.sessionId = sessionId;
  }

  getState(): AgentState {
    return this.state;
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  getIteration(): number {
    return this.iteration;
  }

  /**
   * Load previous session history into the agent's messages.
   * Used by --resume to restore conversation context.
   */
  loadHistory(entries: Array<{ type: string; content: string; metadata?: Record<string, unknown> }>): void {
    for (const entry of entries) {
      if (entry.type === "user") {
        this.messages.push({ role: "user", content: entry.content });
      } else if (entry.type === "agent") {
        this.messages.push({ role: "assistant", content: entry.content });
      } else if (entry.type === "tool_call") {
        this.messages.push({ role: "assistant", content: `[Tool call: ${entry.content}]` });
      } else if (entry.type === "tool_result") {
        const toolUseId = (entry.metadata?.toolUseId as string) || entry.content.slice(0, 40);
        const isError = (entry.metadata?.isError as boolean) || false;
        this.messages.push({
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUseId, content: entry.content, is_error: isError }],
        });
      }
    }
  }

  /**
   * Run one iteration of the agent loop with a user message.
   * Returns the final response text.
   */
  async run(userInput: string): Promise<AgentStep> {
    this.iteration = 0;
    this.setState("thinking");

    // Add user message
    const userMsg: Message = { role: "user", content: userInput };
    this.messages.push(userMsg);

    // Add to MMP if available
    if (this.mmp) {
      this.mmp.addMessage(`User: ${userInput}`);
    }

    // Record in context manager and persist to session store
    const userEntry = {
      id: `user_${Date.now()}`,
      type: "user" as const,
      content: userInput,
      metadata: {},
      timestamp: Date.now(),
      parentId: null as string | null,
    };
    this.contextManager.addEntry(userEntry);
    this.persistEntry(userEntry);

    const toolCalls: ToolCallRequest[] = [];
    const toolResults: ToolCallResult[] = [];

    try {
      // Main loop
      while (this.iteration < this.config.maxIterations) {
        this.iteration++;
        this.setState("thinking");
        this.hooks.onThinking?.();

      // Check if context needs compaction
      if (await this.contextManager.needsCompaction()) {
        await this.compactContext();
      }

      // Check MMP compaction
      if (this.mmp && this.mmp.needsCompaction()) {
        await this.compactMmpContext();
      }

        // Build the request
        const request = this.buildRequest();

        // Get response from LLM
        let response: LLMResponse;

        // Try non-streaming first
        if (this.hooks.onTextDelta) {
          // Use streaming
          let fullText = "";
          const responseToolCalls: ToolUseContent[] = [];

          for await (const event of this.provider.chatStream(request)) {
            switch (event.type) {
              case "text_delta":
                fullText += event.text || "";
                this.hooks.onTextDelta?.(event.text || "");
                break;
              case "tool_use": {
                const tc = event.toolUse;
                if (tc) responseToolCalls.push(tc);
                break;
              }
              case "message_stop":
                break;
              case "error":
                return {
                  iteration: this.iteration,
                  state: "error",
                  messages: this.messages,
                  toolCalls,
                  toolResults,
                  error: event.error,
                };
            }
          }

          response = {
            id: crypto.randomUUID(),
            model: this.currentModel,
            content: fullText
              ? [{ type: "text" as const, text: fullText }, ...responseToolCalls]
              : responseToolCalls,
            stopReason: responseToolCalls.length > 0 ? "tool_use" : "end_turn",
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        } else {
          response = await this.provider.chat(request);
        }

        // Parse the response
        const textContents = response.content.filter(
          (c): c is { type: "text"; text: string } => c.type === "text"
        );
        const toolUseContents = response.content.filter(
          (c): c is ToolUseContent => c.type === "tool_use"
        );

        const responseText = textContents.map((c) => c.text).join("");

        // Add assistant message
        if (responseText || toolUseContents.length > 0) {
          const assistantMsg: Message = {
            role: "assistant",
            content: response.content as MessageContent[],
          };
          this.messages.push(assistantMsg);

          // Record in context manager and persist
          const agentEntry = {
            id: `agent_${Date.now()}`,
            type: "agent" as const,
            content: responseText || "[Tool calls]",
            metadata: { toolCalls: toolUseContents.map((t) => t.name) },
            timestamp: Date.now(),
            parentId: null as string | null,
          };
          this.contextManager.addEntry(agentEntry);
          this.persistEntry(agentEntry);

          // Add to MMP if available
          if (this.mmp && responseText) {
            this.mmp.addMessage(`Assistant: ${responseText}`);
          }
        }

        // If no tool calls, we're done
        if (response.stopReason === "end_turn" || response.stopReason === "stop_sequence") {
          this.setState("done");
          return {
            iteration: this.iteration,
            state: "done",
            messages: this.messages,
            toolCalls,
            toolResults,
          };
        }

        if (response.stopReason === "max_tokens") {
          this.setState("done");
          return {
            iteration: this.iteration,
            state: "done",
            messages: this.messages,
            toolCalls,
            toolResults,
          };
        }

        // Execute tool calls
        this.setState("executing_tools");

        for (const tc of toolUseContents) {
          const request: ToolCallRequest = {
            id: tc.id,
            name: tc.name,
            input: tc.input,
            requiresApproval: this.tools.needsApproval(tc.name),
          };

          toolCalls.push(request);
          await this.hooks.onToolCall?.(request);

          // Check if approval is needed
          let shouldExecute = true;

          if (request.requiresApproval && !this.tools.isApproved(tc.name)) {
            if (this.hooks.onNeedApproval) {
              this.setState("waiting_approval");
              const approval = await this.hooks.onNeedApproval(request);
              if (approval === "deny") {
                shouldExecute = false;
              }
              if (approval === "always") {
                // Will be handled by executeApproved
              }
            } else {
              // In plan mode, deny tool calls that modify files/shell
              if (this.config.mode === "plan") {
                shouldExecute = ["read_file", "list_dir", "glob_file", "search_file", "tree_dir"].includes(tc.name);
              }
            }
          }

          if (!shouldExecute) {
            const result: ToolCallResult = {
              id: tc.id,
              toolName: tc.name,
              output: `User denied execution of tool "${tc.name}"`,
              isError: true,
              metadata: { denied: true },
            };
            toolResults.push(result);
            this.addToolResultToMessages(result);
            this.hooks.onToolResult?.(result);
            continue;
          }

          // Execute the tool
          const result = await this.tools.execute(request);
          toolResults.push(result);

          // Await onToolResult BEFORE adding to messages (enables interactive hooks like ask_user)
          await this.hooks.onToolResult?.(result);

          this.addToolResultToMessages(result);

          // Record tool call and result, persist
          const tcEntry = {
            id: `tool_call_${Date.now()}`,
            type: "tool_call" as const,
            content: `${tc.name}(${JSON.stringify(tc.input)})`,
            metadata: { toolName: tc.name, input: tc.input },
            timestamp: Date.now(),
            parentId: null as string | null,
          };
          this.contextManager.addEntry(tcEntry);
          this.persistEntry(tcEntry);

          const trEntry = {
            id: `tool_result_${Date.now()}`,
            type: "tool_result" as const,
            content: result.output,
            metadata: { toolName: tc.name, isError: result.isError },
            timestamp: Date.now(),
            parentId: null as string | null,
          };
          this.contextManager.addEntry(trEntry);
          this.persistEntry(trEntry);

          // Add tool result to MMP if available
          if (this.mmp) {
            this.mmp.addMessage(`Tool[${tc.name}]: ${result.output.slice(0, 500)}`);
          }
        }
      }

      // Max iterations reached
      this.setState("done");
      return {
        iteration: this.iteration,
        state: "done",
        messages: this.messages,
        toolCalls,
        toolResults,
      };
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.setState("error");
      this.hooks.onError?.(errorMsg);
      return {
        iteration: this.iteration,
        state: "error",
        messages: this.messages,
        toolCalls,
        toolResults,
        error: errorMsg,
      };
    }
  }

  /**
   * Continue from a specific point (e.g., after user interruption).
   */
  async continue(): Promise<AgentStep> {
    // Re-run without adding a new user message
    return this.run("Continue.");
  }

  /**
   * Retry a specific message/tool call from the timeline.
   */
  async retry(entryId: string, newContent?: string): Promise<AgentStep> {
    // Find the index of the specified entry in context timeline
    const entries = this.contextManager.getEntries();
    const entryIdx = entries.findIndex((e) => e.id === entryId);

    if (entryIdx >= 0) {
      // Calculate approximate message index (skip system message)
      const msgIdx = entryIdx + 1; // +1 for system message offset
      if (msgIdx > 0 && msgIdx < this.messages.length) {
        // Truncate messages after this point
        this.messages = this.messages.slice(0, msgIdx);
      }
    }

    if (newContent) {
      this.messages.push({ role: "user", content: newContent });
    }

    return this.run("");
  }

  /**
   * Spawn a subagent for a specific task.
   */
  async spawnSubagent(config: SubagentConfig): Promise<SubagentResult> {
    return this.subagents.spawn(config);
  }

  private buildRequest(): LLMRequest {
    // Filter out system messages from history (they're added separately)
    const nonSystemMessages = this.messages.filter((m) => m.role !== "system");
    const systemMsg = this.messages.find((m) => m.role === "system");

    return {
      model: this.currentModel,
      messages: nonSystemMessages,
      system: systemMsg
        ? typeof systemMsg.content === "string"
          ? systemMsg.content
          : JSON.stringify(systemMsg.content)
        : undefined,
      tools: this.tools.getDefinitions(),
      maxTokens: 8192,
    };
  }

  private addToolResultToMessages(result: ToolCallResult): void {
    const content: ToolUseContent["input"] = typeof result.output === "string"
      ? { text: result.output }
      : result.output;

    this.messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: result.id,
          content: result.output,
          is_error: result.isError,
        },
      ],
    });
  }

  private setState(state: AgentState): void {
    this.state = state;
    this.hooks.onStateChange?.(state);
  }

  /**
   * Compact using MMP's DAG memory system.
   * Takes oldest raw nodes, summarizes them, creates a DAG node.
   */
  private async compactMmpContext(): Promise<void> {
    if (!this.mmp) return;

    try {
      await this.mmp.compact(async (text) => {
        const summary = await this.provider.chat({
          model: this.currentModel,
          messages: [{
            role: "user",
            content: `Summarize the following conversation history concisely. Keep all important decisions, code changes, and key information:\n\n${text}`,
          }],
          maxTokens: 1024,
        });
        return summary.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");
      });
    } catch {
      // Compaction failure is non-fatal
    }
  }

  /**
   * Persist a timeline entry to the session store if connected.
   */
  private persistEntry(entry: {
    id: string;
    type: "user" | "agent" | "tool_call" | "tool_result" | "subagent";
    content: string;
    metadata: Record<string, unknown>;
    timestamp: number;
    parentId: string | null;
  }): void {
    if (this.sessionStore && this.sessionId) {
      try {
        this.sessionStore.saveEntry(this.sessionId, entry, this.entryOrder++);
      } catch {
        // Persistence failure is non-fatal
      }
    }
  }

  /**
   * Compact the context by summarizing older messages.
   * Uses MMP if available, otherwise does inline summarization.
   */
  private async compactContext(): Promise<void> {
    // Take the oldest 1/3 of non-system messages
    const nonSystemMsgs = this.messages.filter((m) => m.role !== "system");
    const cutoff = Math.floor(nonSystemMsgs.length / 3);
    const toCompact = nonSystemMsgs.slice(0, cutoff);

    if (toCompact.length === 0) return;

    // Ask the model to summarize
    const summaryReq: LLMRequest = {
      model: this.currentModel,
      messages: [
        {
          role: "user",
          content: `Summarize the following conversation history concisely. Keep all important decisions, code changes, and key information:\n\n${
            toCompact.map((m) => `${m.role}: ${
              typeof m.content === "string" ? m.content : JSON.stringify(m.content)
            }`).join("\n")
          }`,
        },
      ],
      maxTokens: 1024,
    };

    try {
      const summaryResp = await this.provider.chat(summaryReq);
      const summaryText = summaryResp.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");

      // Replace compacted messages with summary
      const systemMsg = this.messages.find((m) => m.role === "system");
      const remaining = nonSystemMsgs.slice(cutoff);

      this.messages = systemMsg
        ? [
            systemMsg,
            {
              role: "user",
              content: `[Summarized earlier conversation]\n${summaryText}`,
            },
            ...remaining,
          ]
        : [
            {
              role: "user",
              content: `[Summarized earlier conversation]\n${summaryText}`,
            },
            ...remaining,
          ];
    } catch {
      // If summarization fails, just drop oldest messages
      const systemMsg = this.messages.find((m) => m.role === "system");
      const remaining = nonSystemMsgs.slice(cutoff);
      this.messages = systemMsg ? [systemMsg, ...remaining] : remaining;
    }
  }
}
