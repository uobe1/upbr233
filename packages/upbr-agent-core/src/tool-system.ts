import type { ToolDefinition } from "@upbr233/ai";
import type {
  ToolConfig,
  ToolCallRequest,
  ToolCallResult,
  ToolApproval,
  IToolRegistry,
} from "./types";

export class ToolRegistry implements IToolRegistry {
  private tools = new Map<string, ToolConfig>();
  private approvedTools = new Set<string>();

  register(tool: ToolConfig): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
    this.approvedTools.delete(name);
  }

  get(name: string): ToolConfig | undefined {
    return this.tools.get(name);
  }

  getAll(): ToolConfig[] {
    return [...this.tools.values()];
  }

  getDefinitions(): ToolDefinition[] {
    return this.getAll().map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  async execute(request: ToolCallRequest): Promise<ToolCallResult> {
    const tool = this.tools.get(request.name);
    if (!tool) {
      return {
        id: request.id,
        toolName: request.name,
        output: `Error: Unknown tool "${request.name}". Available: ${[
          ...this.tools.keys(),
        ].join(", ")}`,
        isError: true,
      };
    }

    try {
      const result = await tool.handler(request.input);
      return { ...result, id: request.id };
    } catch (e) {
      return {
        id: request.id,
        toolName: request.name,
        output: `Tool execution error: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      };
    }
  }

  async executeApproved(
    request: ToolCallRequest,
    approval: ToolApproval
  ): Promise<ToolCallResult> {
    if (approval === "deny") {
      return {
        id: request.id,
        toolName: request.name,
        output: `User denied execution of tool "${request.name}"`,
        isError: true,
        metadata: { denied: true },
      };
    }

    if (approval === "always") {
      this.approvedTools.add(request.name);
    }

    return this.execute(request);
  }

  isApproved(name: string): boolean {
    return this.approvedTools.has(name);
  }

  needsApproval(name: string): boolean {
    const tool = this.tools.get(name);
    return tool?.requiresApproval ?? false;
  }
}
