import type { IProvider, Message } from "@upbr233/ai";
import type {
  SubagentConfig,
  SubagentResult,
  ToolCallRequest,
  ToolCallResult,
} from "./types";
import type { ToolRegistry } from "./tool-system";
import type { IpcHub } from "./ipc/ipc-hub";
import type { IpcEnvelope } from "./ipc/types";

/**
 * Subagent Manager - manages isolated subagent instances.
 *
 * Each subagent runs in an isolated context to avoid polluting the main
 * agent's context window. Communication happens via IPC (NNG-style)
 * or in-process message passing as fallback.
 *
 * Inspired by OpenCode's subagent system and Kimi Code's parallel subagents.
 */
export class SubagentManager {
  private provider: IProvider;
  private tools: ToolRegistry;
  private running = new Map<string, SubagentInstance>();
  private pendingMessages = new Map<string, string[]>();
  private parentModel: string;
  private ipcHub: IpcHub | null = null;

  constructor(provider: IProvider, tools: ToolRegistry, model?: string) {
    this.provider = provider;
    this.tools = tools;
    this.parentModel = model || "unknown";
  }

  /** Set IPC hub for cross-process subagent communication */
  setIpcHub(hub: IpcHub): void {
    this.ipcHub = hub;
  }

  /** Update the model used by subagents. */
  setModel(model: string): void {
    this.parentModel = model;
  }

  /**
   * Spawn a subagent to execute a specific task.
   */
  async spawn(config: SubagentConfig): Promise<SubagentResult> {
    const subagentId = `subagent_${config.name}_${Date.now()}`;
    const startTime = Date.now();

    const instance: SubagentInstance = {
      id: subagentId,
      name: config.name,
      status: "running",
      startTime,
      messages: [],
      toolCalls: 0,
    };

    this.running.set(subagentId, instance);

    // Notify via IPC that subagent started
    this.notifyIpc(subagentId, "spawned", { name: config.name, prompt: config.prompt.slice(0, 200) });

    try {
      const result = await this.runSubagent(instance, config);
      instance.status = "completed";
      instance.endTime = Date.now();

      // Notify via IPC that subagent completed
      this.notifyIpc(subagentId, "completed", { result: result.slice(0, 500), toolCalls: instance.toolCalls });

      this.running.delete(subagentId);
      return {
        subagentId,
        result,
        toolCalls: instance.toolCalls,
        duration: Date.now() - startTime,
      };
    } catch (e) {
      instance.status = "failed";
      instance.endTime = Date.now();

      // Notify via IPC that subagent failed
      this.notifyIpc(subagentId, "failed", { error: e instanceof Error ? e.message : String(e) });

      this.running.delete(subagentId);
      return {
        subagentId,
        result: "",
        toolCalls: instance.toolCalls,
        duration: Date.now() - startTime,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Send a message to a running subagent.
   */
  sendMessage(subagentId: string, message: string): boolean {
    const instance = this.running.get(subagentId);
    if (!instance) return false;

    const queue = this.pendingMessages.get(subagentId) || [];
    queue.push(message);
    this.pendingMessages.set(subagentId, queue);
    return true;
  }

  /**
   * Check pending messages for a subagent.
   */
  getPendingMessages(subagentId: string): string[] {
    const msgs = this.pendingMessages.get(subagentId) || [];
    this.pendingMessages.delete(subagentId);
    return msgs;
  }

  /**
   * Get a subagent's status.
   */
  getStatus(subagentId: string): SubagentInstance | undefined {
    return this.running.get(subagentId);
  }

  /**
   * Terminate a running subagent.
   */
  terminate(subagentId: string): boolean {
    const instance = this.running.get(subagentId);
    if (!instance) return false;
    instance.status = "failed";
    instance.endTime = Date.now();
    this.running.delete(subagentId);
    return true;
  }

  /** Send IPC notification about subagent state change */
  private notifyIpc(subagentId: string, event: string, data: Record<string, unknown>): void {
    if (!this.ipcHub) return;
    const envelope: IpcEnvelope = {
      id: `sub_${subagentId}_${Date.now()}`,
      type: "NOTIFY",
      from: "agent",
      to: subagentId,
      payload: JSON.stringify({ type: `subagent_${event}`, subagentId, ...data }),
      timestamp: Date.now(),
    };
    this.ipcHub.send(envelope).catch(() => { /* non-critical */ });
  }
    instance: SubagentInstance,
    config: SubagentConfig
  ): Promise<string> {
    const availableTools = this.tools.getAll().filter(
      (t) => config.tools.includes(t.name)
    );

    const systemPrompt = `You are a subagent named "${config.name}".
Your task: ${config.prompt}

You have access to the following tools: ${availableTools.map(t => t.name).join(", ")}.
Complete your task efficiently and report your results.

When you have finished, provide a clear summary of what you did and your findings.`;

    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: config.prompt },
    ];

    let iterations = 0;
    const maxIterations = 20;

    while (iterations < maxIterations) {
      iterations++;

      // Check for pending parent messages
      const pendingMsgs = this.getPendingMessages(instance.id);
      for (const msg of pendingMsgs) {
        messages.push({ role: "user", content: `[From parent]: ${msg}` });
      }

      const response = await this.provider.chat({
        model: this.parentModel,
        messages,
        tools: availableTools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        })),
        maxTokens: 4096,
      });

      const hasToolCalls = response.stopReason === "tool_use";

      messages.push({
        role: "assistant",
        content: response.content,
      });

      if (!hasToolCalls) {
        const textContent = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("");
        return textContent;
      }

      // Execute tool calls
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        const request: ToolCallRequest = {
          id: block.id,
          name: block.name,
          input: block.input,
          requiresApproval: false, // Subagents auto-approve
        };

        const result = await this.tools.execute(request);
        instance.toolCalls++;
        instance.messages.push(request);

        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: block.id,
              content: result.output,
              is_error: result.isError,
            },
          ],
        });
      }
    }

    return "Subagent reached maximum iterations without completing the task.";
  }
}

interface SubagentInstance {
  id: string;
  name: string;
  status: "running" | "completed" | "failed";
  startTime: number;
  endTime?: number;
  messages: ToolCallRequest[];
  toolCalls: number;
}
