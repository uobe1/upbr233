import { describe, test, expect } from "bun:test";
import { ContextManager } from "./context-manager";
import type { ContextManagerConfig } from "./types";

function makeConfig(overrides?: Partial<ContextManagerConfig>): ContextManagerConfig {
  return {
    systemPrompt: "You are a helpful assistant.",
    maxHistoryTokens: 10000,
    compactionThreshold: 0.75,
    ...overrides,
  };
}

describe("ContextManager", () => {
  describe("buildContext", () => {
    test("includes system prompt", async () => {
      const cm = new ContextManager(makeConfig());
      const ctx = await cm.buildContext();
      expect(ctx).toContain("You are a helpful assistant.");
    });

    test("includes persona when set", async () => {
      const cm = new ContextManager(makeConfig({ persona: "Expert coder" }));
      const ctx = await cm.buildContext();
      expect(ctx).toContain("Expert coder");
      expect(ctx).toContain("## Persona");
    });

    test("includes skill index when set", async () => {
      const cm = new ContextManager(makeConfig({
        skillIndex: [
          { name: "skill1", description: "A test skill", magicWords: ["test"], skillPath: "/tmp" },
        ],
      }));
      const ctx = await cm.buildContext();
      expect(ctx).toContain("skill1");
      expect(ctx).toContain("A test skill");
      expect(ctx).toContain("Available Skills");
    });

    test("does not include empty sections", async () => {
      const cm = new ContextManager(makeConfig());
      const ctx = await cm.buildContext();
      // No persona set
      expect(ctx).not.toContain("## Persona");
      // No rules
      expect(ctx).not.toContain("## Project Rules");
      // No skills
      expect(ctx).not.toContain("## Available Skills");
    });
  });

  describe("timeline entries", () => {
    test("addEntry adds to changeable layer", () => {
      const cm = new ContextManager(makeConfig());
      cm.addEntry({
        id: "1",
        type: "user",
        content: "Hello",
        metadata: {},
        timestamp: Date.now(),
        parentId: null,
      });
      expect(cm.getEntries().length).toBe(1);
    });

    test("getEntries returns a copy", () => {
      const cm = new ContextManager(makeConfig());
      cm.addEntry({
        id: "1",
        type: "user",
        content: "Hello",
        metadata: {},
        timestamp: Date.now(),
        parentId: null,
      });
      const entries = cm.getEntries();
      entries.push({
        id: "2",
        type: "agent",
        content: "Hi",
        metadata: {},
        timestamp: Date.now(),
        parentId: null,
      });
      expect(cm.getEntries().length).toBe(1); // original unchanged
    });

    test("deleteEntry removes and creates branch", () => {
      const cm = new ContextManager(makeConfig());
      cm.addEntry({ id: "1", type: "user", content: "first", metadata: {}, timestamp: 1, parentId: null });
      cm.addEntry({ id: "2", type: "agent", content: "second", metadata: {}, timestamp: 2, parentId: null });
      cm.addEntry({ id: "3", type: "user", content: "third", metadata: {}, timestamp: 3, parentId: null });

      const result = cm.deleteEntry("2");
      expect(result).toBeDefined();
      expect(result!.deleted.id).toBe("2");
      expect(result!.newBranch).toBeDefined();
      // Only first remains (entries after deleted also removed)
      expect(cm.getEntries().length).toBe(1);
      expect(cm.getEntries()[0]!.id).toBe("1");
    });

    test("deleteEntry returns null for missing id", () => {
      const cm = new ContextManager(makeConfig());
      expect(cm.deleteEntry("nonexistent")).toBeNull();
    });

    test("withdrawEntry removes entry and all after it", () => {
      const cm = new ContextManager(makeConfig());
      cm.addEntry({ id: "1", type: "user", content: "a", metadata: {}, timestamp: 1, parentId: null });
      cm.addEntry({ id: "2", type: "agent", content: "b", metadata: {}, timestamp: 2, parentId: null });
      cm.addEntry({ id: "3", type: "user", content: "c", metadata: {}, timestamp: 3, parentId: null });

      const removed = cm.withdrawEntry("1");
      expect(removed?.id).toBe("1");
      expect(cm.getEntries().length).toBe(0);
    });

    test("replaceEntry creates new branch and adds replacement entry", () => {
      const cm = new ContextManager(makeConfig());
      cm.addEntry({ id: "1", type: "user", content: "original", metadata: {}, timestamp: 1, parentId: null });

      const ok = cm.replaceEntry("1", { id: "new", type: "user", content: "replaced", metadata: {}, timestamp: 2, parentId: null });
      expect(ok).toBe(true);
      expect(cm.getEntries()[1]?.id).toBe("new");
    });
  });

  describe("compaction", () => {
    test("needsCompaction returns false when under threshold", async () => {
      const cm = new ContextManager(makeConfig({ maxHistoryTokens: 100000, compactionThreshold: 0.75 }));
      const needs = await cm.needsCompaction();
      expect(needs).toBe(false);
    });

    test("needsCompaction returns true when over threshold", async () => {
      const cm = new ContextManager(makeConfig({ maxHistoryTokens: 100, compactionThreshold: 0.1 }));
      // Add many entries to push over threshold
      for (let i = 0; i < 50; i++) {
        cm.addEntry({
          id: `${i}`,
          type: "user",
          content: "This is a long message that contains many characters to inflate the token count estimate significantly. ".repeat(3),
          metadata: {},
          timestamp: Date.now(),
          parentId: null,
        });
      }
      const needs = await cm.needsCompaction();
      expect(needs).toBe(true);
    });
  });

  describe("plugin hooks", () => {
    test("preBuild hook is called before building context", async () => {
      const cm = new ContextManager(makeConfig());
      let called = false;
      cm.onPreBuild(() => { called = true; });
      await cm.buildContext();
      expect(called).toBe(true);
    });

    test("postBuild hook transforms context", async () => {
      const cm = new ContextManager(makeConfig());
      cm.onPostBuild((prompt) => prompt.toUpperCase());
      const ctx = await cm.buildContext();
      expect(ctx).toBe(ctx.toUpperCase());
    });

    test("async postBuild hook works", async () => {
      const cm = new ContextManager(makeConfig());
      cm.onPostBuild(async (prompt) => {
        await new Promise(r => setTimeout(r, 10));
        return "PREFIX: " + prompt;
      });
      const ctx = await cm.buildContext();
      expect(ctx).toStartWith("PREFIX:");
    });
  });

  describe("getLayer", () => {
    test("system layer contains prompt and persona", () => {
      const cm = new ContextManager(makeConfig({ persona: "Helper" }));
      const layer = cm.getLayer("system");
      expect(layer).toContain("helpful assistant");
      expect(layer).toContain("Helper");
    });

    test("rule layer contains skills", () => {
      const cm = new ContextManager(makeConfig({
        skillIndex: [{ name: "s", description: "d", magicWords: [], skillPath: "/x" }],
      }));
      const layer = cm.getLayer("rule");
      expect(layer).toContain("s");
      expect(layer).toContain("d");
    });

    test("changeable layer contains entries", () => {
      const cm = new ContextManager(makeConfig());
      cm.addEntry({ id: "1", type: "user", content: "hello", metadata: {}, timestamp: 0, parentId: null });
      const layer = cm.getLayer("changeable");
      expect(layer).toContain("hello");
    });
  });
});
