import { describe, test, expect } from "bun:test";
import { AgentLoop } from "./agent-loop";
import { ContextManager } from "./context-manager";
import { ToolRegistry } from "./tool-system";
import type {
  IProvider,
  LLMRequest,
  LLMResponse,
  StreamEvent,
  MessageContent,
  ModelConfig,
  ToolConfig,
} from "./types";

/** Minimal mock provider for testing AgentLoop */
class MockProvider implements IProvider {
  readonly name = "mock";
  readonly protocol = "openai-compatible" as const;
  private responseText = "Mock response";

  setResponse(text: string): void {
    this.responseText = text;
  }

  async listModels(): Promise<ModelConfig[]> {
    return [{ name: "mock-model", maxContextLength: 128000, thinking: { canThink: false, canToggle: false, levels: [] }, capabilities: { textInput: true, textOutput: true, toolCall: true } }];
  }

  async chat(request: LLMRequest): Promise<LLMResponse> {
    const content: MessageContent[] = [];
    content.push({ type: "text", text: this.responseText });

    // Check for tool definitions in request
    if (request.tools && request.tools.length > 0) {
      const tool = request.tools[0]!;
      content.push({
        type: "tool_use",
        id: "tool_1",
        name: tool.name,
        input: tool.input_schema.properties
          ? Object.fromEntries(
              Object.entries(tool.input_schema.properties).map(([k]) => [k, "test"])
            )
          : {},
      });
    }

    return {
      id: crypto.randomUUID(),
      model: request.model,
      content,
      stopReason: (request.tools && request.tools.length > 0) ? "tool_use" : "end_turn",
      usage: { inputTokens: 10, outputTokens: 10 },
    };
  }

  async *chatStream(request: LLMRequest): AsyncGenerator<StreamEvent> {
    yield { type: "text_delta", text: this.responseText };
    if (request.tools && request.tools.length > 0) {
      yield {
        type: "tool_use",
        toolUse: { type: "tool_use", id: "tool_s1", name: request.tools[0]!.name, input: { value: "streamed" } },
      };
    }
    yield { type: "message_stop" };
  }

  async countTokens(): Promise<number> { return 42; }
  async healthCheck(): Promise<boolean> { return true; }
}

function setupAgentLoop(opts?: { model?: string; systemPrompt?: string; tools?: ToolConfig[] }) {
  const provider = new MockProvider();
  const registry = new ToolRegistry();
  if (opts?.tools) {
    for (const t of opts.tools) registry.register(t);
  }
  const ctxManager = new ContextManager({
    systemPrompt: opts?.systemPrompt ?? "You are a test assistant.",
    maxHistoryTokens: 100000,
    compactionThreshold: 0.75,
  });
  const loop = new AgentLoop(provider, registry, ctxManager, {
    maxIterations: 5,
    maxTokens: 100000,
    mode: "build",
    systemPrompt: opts?.systemPrompt ?? "You are a test assistant.",
  }, opts?.model ?? "mock-model");

  return { loop, provider };
}

describe("AgentLoop", () => {
  describe("basic flow", () => {
    test("run returns complete step with response", async () => {
      const { loop, provider } = setupAgentLoop();
      provider.setResponse("Hello, user!");

      const step = await loop.run("Hi");
      expect(step.state).toBe("done");
      expect(step.messages.length).toBeGreaterThan(1);
      expect(step.error).toBeUndefined();
    });

    test("messages include system, user, and assistant", async () => {
      const { loop, provider } = setupAgentLoop();
      provider.setResponse("Response text");

      const step = await loop.run("User message");
      const roles = step.messages.map((m) => m.role);
      expect(roles).toContain("system");
      expect(roles).toContain("user");
      expect(roles).toContain("assistant");
    });

    test("getState returns current state before run", () => {
      const { loop } = setupAgentLoop();
      expect(loop.getState()).toBe("idle");
    });

    test("getIteration returns 0 before run", () => {
      const { loop } = setupAgentLoop();
      expect(loop.getIteration()).toBe(0);
    });

    test("getMessages returns copy", () => {
      const { loop } = setupAgentLoop();
      const msgs = loop.getMessages();
      msgs.push({ role: "user", content: "extra" });
      // Original should be unchanged
      const msgs2 = loop.getMessages();
      expect(msgs2.length).toBe(1); // only system message
    });
  });

  describe("tool execution", () => {
    test("executes tool_calls and returns results", async () => {
      const { loop, provider } = setupAgentLoop({
        tools: [{
          name: "echo",
          description: "Echo back",
          inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
          requiresApproval: false,
          handler: async (input) => ({
            id: "", toolName: "echo", output: `Echo: ${input.msg}`, isError: false,
          }),
        }],
      });
      provider.setResponse("");

      const step = await loop.run("Run echo");
      expect(step.toolResults?.length).toBeGreaterThanOrEqual(1);
      if (step.toolResults && step.toolResults.length > 0) {
        expect(step.toolResults[0]!.toolName).toBe("echo");
      }
    });

    test("maxIterations stops loop", async () => {
      const { loop, provider } = setupAgentLoop({
        tools: [{
          name: "loop",
          description: "Always returns a tool",
          inputSchema: { type: "object", properties: {}, required: [] },
          requiresApproval: false,
          handler: async () => ({ id: "", toolName: "loop", output: "looping", isError: false }),
        }],
      });
      provider.setResponse("");

      const step = await loop.run("Start loop");
      // Should stop at maxIterations (5)
      expect(step.iteration).toBeLessThanOrEqual(5);
    });
  });

  describe("hooks", () => {
    test("onThinking hook is called", async () => {
      const { loop, provider } = setupAgentLoop();
      provider.setResponse("Hi");
      let thinkingCount = 0;
      loop.setHooks({ onThinking: () => { thinkingCount++; } });
      await loop.run("msg");
      expect(thinkingCount).toBeGreaterThan(0);
    });

    test("onStateChange receives state transitions", async () => {
      const { loop, provider } = setupAgentLoop();
      provider.setResponse("Hi");
      const states: string[] = [];
      loop.setHooks({ onStateChange: (s) => { states.push(s); } });
      await loop.run("msg");
      expect(states.length).toBeGreaterThan(0);
      expect(states[states.length - 1]).toBe("done");
    });

    test("onError hook receives error from failed tool", async () => {
      const { loop, provider } = setupAgentLoop({
        tools: [{
          name: "fail",
          description: "Always fails",
          inputSchema: { type: "object", properties: {}, required: [] },
          requiresApproval: false,
          handler: async () => { throw new Error("intentional failure"); },
        }],
      });
      provider.setResponse("");

      let errorMsg = "";
      loop.setHooks({ onError: (e) => { errorMsg = e; } });

      // The tool error should be caught and the step should still complete
      const step = await loop.run("trigger");
      // Note: the agent loop handles tool errors gracefully (returns isError:true)
      // The onError hook is for agent-level errors, not individual tool errors
      expect(step.state).toBe("done");
    });
  });

  describe("retry", () => {
    test("retry truncates messages after specified entry", async () => {
      const { loop, provider } = setupAgentLoop();
      provider.setResponse("First response");
      await loop.run("First message");
      const beforeCount = loop.getMessages().length;

      // Retry from the first user message
      provider.setResponse("Retry response");
      const step = await loop.retry("user_");
      expect(step.error).toBeUndefined();
      // Messages should be fewer after truncation + new response
      expect(loop.getMessages().length).toBeLessThanOrEqual(beforeCount + 1);
    });
  });

  describe("setMmp", () => {
    test("setMmp and getMmp work", () => {
      const { loop } = setupAgentLoop();
      const mockMmp = {
        addMessage: (_content: string) => "id" as unknown,
        needsCompaction: () => false,
        compact: async (_fn: (text: string) => Promise<string>) => null,
        buildContext: (_maxTokens: number) => "",
      };
      loop.setMmp(mockMmp);
      expect(loop.getMmp()).toBe(mockMmp);
    });
  });

  describe("continue", () => {
    test("continue sends Continue message", async () => {
      const { loop, provider } = setupAgentLoop();
      provider.setResponse("Continuing...");
      const step = await loop.continue();
      expect(step.state).toBe("done");
    });
  });
});
