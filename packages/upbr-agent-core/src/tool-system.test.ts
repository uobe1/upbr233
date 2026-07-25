import { describe, test, expect } from "bun:test";
import { ToolRegistry } from "./tool-system";
import type { ToolConfig, ToolCallRequest } from "./types";

function makeTool(overrides?: Partial<ToolConfig>): ToolConfig {
  return {
    name: overrides?.name ?? "test_tool",
    description: overrides?.description ?? "A test tool",
    inputSchema: {
      type: "object",
      properties: {
        value: { type: "string", description: "A value" },
      },
      required: ["value"],
    },
    requiresApproval: overrides?.requiresApproval ?? false,
    handler: overrides?.handler ?? (async (input) => ({
      id: "",
      toolName: "test_tool",
      output: `Got: ${input.value}`,
      isError: false,
    })),
  };
}

function makeRequest(name: string, input: Record<string, unknown>): ToolCallRequest {
  return { id: `req_${crypto.randomUUID().slice(0, 8)}`, name, input, requiresApproval: false };
}

describe("ToolRegistry", () => {
  describe("register / get / getAll", () => {
    test("registers and retrieves a tool", () => {
      const reg = new ToolRegistry();
      const tool = makeTool();
      reg.register(tool);
      expect(reg.get("test_tool")).toBe(tool);
    });

    test("get returns undefined for unknown tool", () => {
      const reg = new ToolRegistry();
      expect(reg.get("missing")).toBeUndefined();
    });

    test("register duplicate throws", () => {
      const reg = new ToolRegistry();
      reg.register(makeTool());
      expect(() => reg.register(makeTool())).toThrow(/already registered/);
    });

    test("getAll returns all tools", () => {
      const reg = new ToolRegistry();
      reg.register(makeTool({ name: "a" }));
      reg.register(makeTool({ name: "b" }));
      expect(reg.getAll().length).toBe(2);
    });

    test("unregister removes tool", () => {
      const reg = new ToolRegistry();
      reg.register(makeTool());
      reg.unregister("test_tool");
      expect(reg.get("test_tool")).toBeUndefined();
    });
  });

  describe("execute", () => {
    test("executes tool handler and returns result", async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool());
      const result = await reg.execute(makeRequest("test_tool", { value: "hello" }));
      expect(result.output).toBe("Got: hello");
      expect(result.isError).toBe(false);
      expect(result.id).toBeDefined();
    });

    test("returns error for unknown tool", async () => {
      const reg = new ToolRegistry();
      const result = await reg.execute(makeRequest("unknown", {}));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Unknown tool");
    });

    test("returns error when handler throws", async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool({
        handler: async () => { throw new Error("boom"); },
      }));
      const result = await reg.execute(makeRequest("test_tool", { value: "x" }));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("boom");
    });

    test("result id matches request id", async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool());
      const req = makeRequest("test_tool", { value: "x" });
      const result = await reg.execute(req);
      expect(result.id).toBe(req.id);
    });
  });

  describe("approvals", () => {
    test("needsApproval returns false by default", () => {
      const reg = new ToolRegistry();
      reg.register(makeTool());
      expect(reg.needsApproval("test_tool")).toBe(false);
    });

    test("needsApproval returns true when requiresApproval is set", () => {
      const reg = new ToolRegistry();
      reg.register(makeTool({ requiresApproval: true }));
      expect(reg.needsApproval("test_tool")).toBe(true);
    });

    test("needsApproval returns false for unknown tool", () => {
      const reg = new ToolRegistry();
      expect(reg.needsApproval("unknown")).toBe(false);
    });

    test("isApproved returns false before approval", () => {
      const reg = new ToolRegistry();
      reg.register(makeTool());
      expect(reg.isApproved("test_tool")).toBe(false);
    });

    test("executeApproved with 'deny' returns error without executing", async () => {
      const reg = new ToolRegistry();
      let called = false;
      reg.register(makeTool({
        handler: async () => { called = true; return { id: "", toolName: "t", output: "ok", isError: false }; },
      }));
      const result = await reg.executeApproved(
        makeRequest("test_tool", {}), "deny"
      );
      expect(result.isError).toBe(true);
      expect(result.metadata?.denied).toBe(true);
      expect(called).toBe(false);
    });

    test("executeApproved with 'always' marks tool as approved and executes", async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool());
      await reg.executeApproved(makeRequest("test_tool", { value: "x" }), "always");
      expect(reg.isApproved("test_tool")).toBe(true);
    });

    test("executeApproved with 'once' executes without marking approved", async () => {
      const reg = new ToolRegistry();
      reg.register(makeTool());
      const result = await reg.executeApproved(
        makeRequest("test_tool", { value: "once" }), "once"
      );
      expect(result.isError).toBe(false);
      expect(reg.isApproved("test_tool")).toBe(false);
    });
  });

  describe("getDefinitions", () => {
    test("returns Anthropic-compatible tool definitions", () => {
      const reg = new ToolRegistry();
      reg.register(makeTool());
      const defs = reg.getDefinitions();
      expect(defs.length).toBe(1);
      expect(defs[0]!.name).toBe("test_tool");
      expect(defs[0]!.input_schema.type).toBe("object");
    });
  });
});
